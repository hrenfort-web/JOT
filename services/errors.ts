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
        userMessage: "Can't reach BQE Core. Your changes will sync when you're back online.",
      };
    }
    const status = ax.response.status;
    if (status === 401 || status === 403) {
      return { code: 'auth', userMessage: 'Your session expired — please log in again.' };
    }
    if (status === 404) {
      return { code: 'not_found', userMessage: 'BQE could not find that record.' };
    }
    if (status === 429) {
      return { code: 'rate_limit', userMessage: "BQE is busy — your changes are queued and will retry shortly." };
    }
    if (status >= 500) {
      return { code: 'server', userMessage: 'BQE Core had a hiccup. Try again in a moment.' };
    }
    if (status >= 400) {
      return { code: 'validation', userMessage: 'BQE rejected this request — please check the details.' };
    }
  }
  return { code: 'unknown', userMessage: 'Something went wrong. Please try again.' };
}

export function logError(scope: string, e: unknown): void {
  console.error(`[jot:${scope}]`, e);
}

function isAbortError(e: unknown): boolean {
  return !!(e instanceof Error && (e.name === 'AbortError' || e.name === 'CanceledError'));
}
