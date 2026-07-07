import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../../store/useAuthStore';
import { isTokenExpiringWithin } from './auth';
import { logError } from '../errors';

type RetriableConfig = InternalAxiosRequestConfig & {
  _retriedAuth?: boolean;
  _retried5xx?: boolean;
};

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_5XX_DELAY_MS = 800;

// Threshold for the request interceptor's proactive refresh path. If a
// write (POST/PUT/DELETE) is about to fire and the token expires within
// this window, refresh BEFORE the request instead of waiting for the 401
// → refresh → retry cycle. Tighter than prewarm's 10-minute window so a
// write that just barely missed prewarm's threshold still gets covered.
const PROACTIVE_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

// Cap for the always-on diagnostic body dumps. 4000 chars comfortably fits
// a 10-entry timeentry batch (~250 chars/entry pretty-printed) and the
// largest BQE error envelope we've seen in the wild. Beyond this we
// truncate with a marker so the in-app log buffer doesn't blow its
// memory ceiling under a pathological response (e.g. 50KB JSON dump).
const DIAGNOSTIC_BODY_MAX = 4000;

/**
 * Pretty-print a request/response body for the diagnostic log channel.
 * Handles strings (returned as-is), objects (JSON.stringify with 2-space
 * indent), null/undefined (returned as their string forms), and
 * unserialisable cycles (returned as "<unserializable>"). Always truncates
 * to DIAGNOSTIC_BODY_MAX chars with a "… (truncated)" marker so the
 * in-app log buffer stays bounded.
 */
function safePretty(v: unknown): string {
  let s: string;
  if (v === undefined) {
    s = '<no body>';
  } else if (typeof v === 'string') {
    s = v;
  } else if (v === null) {
    s = 'null';
  } else {
    try {
      s = JSON.stringify(v, null, 2);
    } catch {
      s = '<unserializable>';
    }
  }
  if (s.length > DIAGNOSTIC_BODY_MAX) {
    return `${s.slice(0, DIAGNOSTIC_BODY_MAX)}… (truncated, ${s.length} total chars)`;
  }
  return s;
}

export const bqeClient = axios.create({ timeout: REQUEST_TIMEOUT_MS });

// Refresh-token rotation is single-flighted inside useAuthStore.refreshTokens
// itself (module-level guard), so both interceptor paths — and prewarm and
// loadStoredTokens — share ONE in-flight rotation. The interceptors call
// refreshTokens() directly; there is no client-local dedupe wrapper.

bqeClient.interceptors.request.use(async (config) => {
  const state = useAuthStore.getState();
  const tokens = state.tokens;
  const baseUrl = state.baseUrl;

  // Proactive refresh: for writes (POST/PUT/PATCH/DELETE), if the token
  // is about to expire, refresh BEFORE sending. Eliminates the
  // 401 → refresh → retry round-trip that dominates first-save latency.
  // Demo mode tokens are 1-year-valid so they never trip the threshold.
  const method = (config.method ?? 'get').toLowerCase();
  if (
    tokens?.refreshToken &&
    WRITE_METHODS.has(method) &&
    isTokenExpiringWithin(tokens, PROACTIVE_REFRESH_THRESHOLD_MS)
  ) {
    console.log(
      `[jot:client] proactive token refresh before ${method.toUpperCase()} ${config.url ?? ''}`,
    );
    try {
      await useAuthStore.getState().refreshTokens();
    } catch (err) {
      // Refresh failed — fall through and let the request fire with the
      // stale token. The response interceptor's 401 path will handle it
      // (and log out cleanly if a second refresh attempt also fails).
      if (__DEV__) {
        console.log(
          '[jot:client] proactive refresh failed, falling through to reactive path:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Re-read state after any refresh — the access token may have changed.
  const freshTokens = useAuthStore.getState().tokens;
  if (baseUrl && !config.baseURL) {
    // Strip trailing slash so e.g. "https://api.bqecore.com/api" + "/employee"
    // doesn't become "...api//employee". Also catches stored tokens that were
    // persisted before the auth-side strip was added.
    config.baseURL = baseUrl.replace(/\/+$/, '');
  }
  if (config.baseURL) {
    config.baseURL = config.baseURL.replace(/\/+$/, '');
  }
  if (freshTokens?.accessToken && !config.headers.has('Authorization')) {
    config.headers.set('Authorization', `Bearer ${freshTokens.accessToken}`);
  }
  if (!config.headers.has('X-UTC-OFFSET')) {
    config.headers.set('X-UTC-OFFSET', String(-new Date().getTimezoneOffset()));
  }

  // Always-on request log with time-to-expiry. Lets us correlate request
  // timing in the Debug log buffer with how close we were to expiry —
  // useful for "did this slow save coincide with an about-to-expire
  // token?" diagnostics. Negative ms means already expired (the request
  // is about to 401).
  const expiresInMs =
    freshTokens?.expiresAt != null ? freshTokens.expiresAt - Date.now() : null;
  const expiresStr = expiresInMs == null ? 'no-token' : `${expiresInMs}ms`;
  const methodUpper = (config.method ?? 'GET').toUpperCase();
  console.log(
    `[jot:client] ${methodUpper} ${config.url ?? ''} starting, token expires in ${expiresStr}`,
  );

  if (__DEV__) {
    const fullUrl = `${config.baseURL ?? ''}${config.url ?? ''}`;
    const params = config.params
      ? ` params=${JSON.stringify(config.params)}`
      : '';
    console.log(
      `[jot:bqe] -> ${methodUpper} ${fullUrl}${params}`,
    );
  }

  // ALWAYS-ON diagnostic for write methods. Dumps the outgoing body so we
  // can correlate any subsequent failure with exactly what we sent. Not
  // gated on __DEV__ — this is the line H asked for in the preview-build
  // log buffer. GETs are filtered out so the buffer doesn't flood with
  // routine list-fetch noise.
  if (WRITE_METHODS.has(method)) {
    console.log(
      `[jot:bqe-request] ${methodUpper} ${config.url ?? ''} payload = ${safePretty(config.data)}`,
    );
  }
  return config;
});

bqeClient.interceptors.response.use(
  (response) => {
    const cfg = response.config;
    const cfgMethod = (cfg.method ?? 'get').toLowerCase();

    // ALWAYS-ON diagnostic for write-method success responses. Lets us see
    // what a passing payload looks like for comparison against a failing
    // one. Same filter as the request side (writes only) to keep buffer
    // chatter under control.
    if (WRITE_METHODS.has(cfgMethod)) {
      console.log(
        `[jot:bqe-response] status=${response.status} body = ${safePretty(response.data)}`,
      );
    }

    if (__DEV__) {
      console.log(
        `[jot:bqe] <- ${response.status} ${cfgMethod.toUpperCase()} ${cfg.baseURL ?? ''}${cfg.url ?? ''}`,
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

    // ALWAYS-ON diagnostic on error — the headline reason this logging
    // exists. Captures the full response body (pretty-printed, truncated
    // at 4KB) regardless of __DEV__. Complements the existing
    // [jot:bqe-error] line from extractBqeErrorMessage, which logs the
    // same body more tersely. Having both means we always have a
    // pretty-printed copy in the buffer.
    console.log(
      `[jot:bqe-response] status=${status ?? 'NO_RESPONSE'} body = ${safePretty(error.response?.data)}`,
    );

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
      try {
        await useAuthStore.getState().refreshTokens();
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
