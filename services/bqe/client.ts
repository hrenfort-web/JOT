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
  if (baseUrl && !config.baseURL) {
    // Strip trailing slash so e.g. "https://api.bqecore.com/api" + "/employee"
    // doesn't become "...api//employee". Also catches stored tokens that were
    // persisted before the auth-side strip was added.
    config.baseURL = baseUrl.replace(/\/+$/, '');
  }
  if (config.baseURL) {
    config.baseURL = config.baseURL.replace(/\/+$/, '');
  }
  if (tokens?.accessToken && !config.headers.has('Authorization')) {
    config.headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }
  if (!config.headers.has('X-UTC-OFFSET')) {
    config.headers.set('X-UTC-OFFSET', String(-new Date().getTimezoneOffset()));
  }
  if (__DEV__) {
    const fullUrl = `${config.baseURL ?? ''}${config.url ?? ''}`;
    const params = config.params
      ? ` params=${JSON.stringify(config.params)}`
      : '';
    console.log(
      `[jot:bqe] -> ${(config.method ?? 'GET').toUpperCase()} ${fullUrl}${params}`,
    );
  }
  return config;
});

let refreshInFlight: Promise<void> | null = null;

bqeClient.interceptors.response.use(
  (response) => {
    if (__DEV__) {
      const cfg = response.config;
      console.log(
        `[jot:bqe] <- ${response.status} ${(cfg.method ?? 'GET').toUpperCase()} ${cfg.baseURL ?? ''}${cfg.url ?? ''}`,
      );
      const h = response.headers as Record<string, string> | undefined;
      const pagHeaders: Record<string, string> = {};
      if (h) {
        for (const key of Object.keys(h)) {
          const lc = key.toLowerCase();
          if (
            lc.includes('total') ||
            lc.includes('page') ||
            lc.includes('count') ||
            lc.includes('link')
          ) {
            pagHeaders[key] = h[key];
          }
        }
      }
      if (Object.keys(pagHeaders).length > 0) {
        console.log('[jot:bqe]    pagination headers =', pagHeaders);
      }
      const traceHeaders: Record<string, string> = {};
      if (h) {
        for (const key of Object.keys(h)) {
          const lc = key.toLowerCase();
          if (
            lc.includes('request-id') ||
            lc.includes('correlation') ||
            lc === 'x-trace-id' ||
            lc === 'traceparent'
          ) {
            traceHeaders[key] = h[key];
          }
        }
      }
      if (Object.keys(traceHeaders).length > 0) {
        console.log('[jot:bqe]    trace headers =', traceHeaders);
      }
    }
    return response;
  },
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;

    if (__DEV__) {
      const fullUrl = `${config?.baseURL ?? ''}${config?.url ?? ''}`;
      let bodyPreview: string;
      const data = error.response?.data;
      if (typeof data === 'string') {
        bodyPreview = data.slice(0, 600);
      } else if (data) {
        try {
          bodyPreview = JSON.stringify(data).slice(0, 600);
        } catch {
          bodyPreview = '<unserializable>';
        }
      } else {
        bodyPreview = error.message;
      }
      console.log(
        `[jot:bqe] <- ${status ?? 'NO_RESPONSE'} ${(config?.method ?? 'GET').toUpperCase()} ${fullUrl}`,
      );
      console.log('[jot:bqe]    body =', bodyPreview);
      if (config?.params) {
        console.log('[jot:bqe]    params =', JSON.stringify(config.params));
      }
      // Capture any trace/correlation/request-id headers — BQE support asks
      // for these when filing tickets against a specific 4xx.
      const errHeaders = error.response?.headers as Record<string, string> | undefined;
      if (errHeaders) {
        const trace: Record<string, string> = {};
        for (const key of Object.keys(errHeaders)) {
          const lc = key.toLowerCase();
          if (
            lc.includes('request-id') ||
            lc.includes('correlation') ||
            lc === 'x-trace-id' ||
            lc === 'traceparent'
          ) {
            trace[key] = errHeaders[key];
          }
        }
        if (Object.keys(trace).length > 0) {
          console.log('[jot:bqe]    trace headers =', trace);
        }
      }
      // For POST/PUT, dump the request body too so we can compare what we
      // sent vs. what BQE expected.
      if (config?.data) {
        let reqBody: string;
        if (typeof config.data === 'string') {
          reqBody = config.data.slice(0, 800);
        } else {
          try {
            reqBody = JSON.stringify(config.data).slice(0, 800);
          } catch {
            reqBody = '<unserializable>';
          }
        }
        console.log('[jot:bqe]    request body =', reqBody);
      }
    }

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

// Auto-paginate any BQE list endpoint using BQE's documented `page=N,M` format
// (page number, page size). Stops on HTTP 204 (past last page per BQE docs) or
// when a partial page comes back. Default page size 500 — well under the 1000
// cap and well over the 25 default.
//   https://api-explorer.bqecore.com/docs/filtering#page-filter
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGES = 100;

interface FetchAllPagesOptions {
  pageSize?: number;
  baseURL?: string;
  headers?: Record<string, string>;
}

export async function fetchAllPages<T>(
  url: string,
  baseParams: Record<string, unknown> = {},
  options: FetchAllPagesOptions = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const all: T[] = [];
  let pageNumber = 1;

  while (pageNumber <= MAX_PAGES) {
    const response = await bqeClient.get(url, {
      baseURL: options.baseURL,
      headers: options.headers,
      params: { ...baseParams, page: `${pageNumber},${pageSize}` },
    });

    if (response.status === 204) break;

    const data = response.data;
    let rows: T[];
    if (Array.isArray(data)) {
      rows = data as T[];
    } else if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.value)) rows = obj.value as T[];
      else if (Array.isArray(obj.data)) rows = obj.data as T[];
      else if (Array.isArray(obj.items)) rows = obj.items as T[];
      else rows = [];
    } else {
      rows = [];
    }

    all.push(...rows);

    if (rows.length === 0) break;
    if (rows.length < pageSize) break;
    pageNumber += 1;
  }

  if (__DEV__) {
    console.log(
      `[jot:bqe] fetchAllPages ${url} retrieved ${all.length} total rows across ${pageNumber} page(s)`,
    );
  }
  return all;
}
