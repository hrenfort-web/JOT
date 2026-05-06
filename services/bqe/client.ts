import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../../store/useAuthStore';
import { logError } from '../errors';

type RetriableConfig = InternalAxiosRequestConfig & {
  _retriedAuth?: boolean;
  _retried5xx?: boolean;
};

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_5XX_DELAY_MS = 800;

export const bqeClient = axios.create({ timeout: REQUEST_TIMEOUT_MS });

bqeClient.interceptors.request.use((config) => {
  const { tokens, baseUrl } = useAuthStore.getState();
  if (baseUrl && !config.baseURL) config.baseURL = baseUrl;
  if (tokens?.accessToken && !config.headers.has('Authorization')) {
    config.headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }
  if (!config.headers.has('X-UTC-OFFSET')) {
    config.headers.set('X-UTC-OFFSET', String(-new Date().getTimezoneOffset()));
  }
  return config;
});

let refreshInFlight: Promise<void> | null = null;

bqeClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;

    if (status === 401 && config && !config._retriedAuth) {
      config._retriedAuth = true;
      const store = useAuthStore.getState();
      if (!store.tokens?.refreshToken) {
        await store.logout('session_expired');
        throw error;
      }
      if (!refreshInFlight) {
        refreshInFlight = store.refreshTokens().finally(() => {
          refreshInFlight = null;
        });
      }
      try {
        await refreshInFlight;
      } catch (refreshErr) {
        logError('client.refresh', refreshErr);
        await useAuthStore.getState().logout('session_expired');
        throw refreshErr;
      }
      config.headers.delete('Authorization');
      return bqeClient(config);
    }

    if (status === 429 && config) {
      const retryAfter = Number(error.response?.headers?.['retry-after'] ?? 5);
      await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
      return bqeClient(config);
    }

    if (status && status >= 500 && status < 600 && config && !config._retried5xx) {
      config._retried5xx = true;
      logError('client.5xx-retry', { status, url: config.url });
      await new Promise((r) => setTimeout(r, RETRY_5XX_DELAY_MS));
      return bqeClient(config);
    }

    throw error;
  },
);
