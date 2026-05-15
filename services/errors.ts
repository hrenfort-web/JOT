import type { AxiosError } from 'axios';

export type AppErrorCode =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'validation'
  | 'not_found'
  | 'unknown';

export interface AppError {
  code: AppErrorCode;
  userMessage: string;
}

export function formatError(e: unknown): AppError {
  if (isAbortError(e)) {
    return { code: 'timeout', userMessage: 'Request timed out. Check your connection and try again.' };
  }
  const ax = e as AxiosError | undefined;
  if (ax && ax.isAxiosError) {
    if (!ax.response) {
      const code = ax.code;
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return { code: 'timeout', userMessage: 'Request timed out. Check your connection and try again.' };
      }
      return {
        code: 'network',
        userMessage: "Can't reach the server. Your changes will sync when you're back online.",
      };
    }
    const status = ax.response.status;
    if (status === 401 || status === 403) {
      return { code: 'auth', userMessage: 'Your session expired — please log in again.' };
    }
    if (status === 404) {
      return { code: 'not_found', userMessage: 'That record was not found.' };
    }
    if (status === 429) {
      return { code: 'rate_limit', userMessage: "The server is busy — your changes are queued and will retry shortly." };
    }
    if (status >= 500) {
      return { code: 'server', userMessage: 'The server had a hiccup. Try again in a moment.' };
    }
    if (status >= 400) {
      return { code: 'validation', userMessage: 'The server rejected this request — please check the details.' };
    }
  }
  return { code: 'unknown', userMessage: 'Something went wrong. Please try again.' };
}

export function logError(scope: string, e: unknown): void {
  console.error(`[jot:${scope}]`, e);
}

/**
 * Returns a human-readable BQE error string when the failure was an HTTP
 * response from BQE (4xx/5xx with a body), or null when it was purely a
 * transport-level failure (offline, timeout, no response).
 *
 * Callers should branch on null vs non-null:
 *   - null → don't surface anything user-hostile; the queue/local-save
 *     fallback will retry when the network recovers.
 *   - non-null → BQE actively rejected the request; surface the message so
 *     the user can fix the underlying issue (most commonly an
 *     activity/project mismatch causing ProjectControlLimitation) rather
 *     than waiting for a retry that will never succeed.
 *
 * The full response body is also printed via console.error so it lands in
 * the in-app log buffer for the Debug → View Logs screen.
 */
export function extractBqeErrorMessage(e: unknown): string | null {
  const ax = e as AxiosError | undefined;
  if (!ax || !ax.isAxiosError) return null;
  if (!ax.response) return null; // network / timeout — caller handles silently

  const status = ax.response.status;
  const data = ax.response.data;

  // Capture the full body to the log buffer. This is the diagnostic
  // payload — keep it on a separate line so the human-friendly message
  // can stand alone for the toast.
  console.error(
    `[jot:bqe-error] ${status} response =`,
    safeStringify(data),
  );

  // Try several shapes — BQE's error envelope has shifted across endpoints.
  // Most common today: `{ message: "...", errorCode: "031.001" }` or
  // `{ error: { message: "..." } }` or just a plain string body.
  const fromBody = pickBqeMessage(data);
  if (fromBody) return `Server error: ${fromBody}`;

  return `Server error: HTTP ${status}`;
}

function pickBqeMessage(data: unknown): string | null {
  if (typeof data === 'string' && data.trim().length > 0) {
    return data.slice(0, 240);
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const directMsg = pickString(obj, ['message', 'Message', 'detail', 'title']);
    const errCode = pickString(obj, ['errorCode', 'code', 'error_code']);
    if (directMsg && errCode) return `${errCode} ${directMsg}`;
    if (directMsg) return directMsg;
    const nestedErr = obj.error;
    if (nestedErr && typeof nestedErr === 'object') {
      const inner = pickString(nestedErr as Record<string, unknown>, [
        'message',
        'Message',
        'detail',
      ]);
      if (inner) return inner;
    } else if (typeof nestedErr === 'string' && nestedErr.length > 0) {
      return nestedErr;
    }
  }
  return null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 240);
  }
  return null;
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 800);
  try {
    return JSON.stringify(v).slice(0, 800);
  } catch {
    return '<unserializable>';
  }
}

function isAbortError(e: unknown): boolean {
  return !!(e instanceof Error && (e.name === 'AbortError' || e.name === 'CanceledError'));
}
