// Pre-warms the BQE connection so the first save of a session doesn't pay
// the cold-start cost (TLS handshake + reactive 401 → refresh → retry).
//
// Called from:
//   - app/_layout.tsx after stored tokens are loaded on launch (fire-and-
//     forget — runs in parallel with initial sync, doesn't gate UI).
//   - app/_layout.tsx AppState listener when the app returns from
//     background → active AND the previous background period was longer
//     than the foreground-prewarm threshold (5 min by default; we treat
//     anything shorter as "user briefly switched apps", which doesn't
//     usually exhaust TLS connection state).
//
// Behavior contract:
//   1. Debounce — if a prewarm completed within `debounceMs` (default 60s),
//      return immediately without doing anything. Guards against duplicate
//      calls from overlapping triggers (e.g. AppState toggling rapidly).
//   2. Single-flight — if a prewarm is in progress, the second caller
//      awaits the same promise instead of starting a parallel run.
//   3. Token refresh — if the token expires within `refreshThresholdMs`
//      (default 10 min), refresh before the warmup GET. A failed refresh
//      logs out the session (matching the reactive 401 path) and returns
//      early; we deliberately do NOT throw to the caller, so a hooked-in
//      fire-and-forget call site doesn't see a rejected promise.
//   4. Warmup GET — single lightweight call to /employee?fields=id&page=1,1
//      to establish TLS state. Errors are logged and swallowed; the user's
//      real save will fall into the offline queue if the network is
//      genuinely unreachable.
//   5. Records timestamps for debounce; emits a [jot:prewarm] log line
//      with timing + refresh flag so we can see in the Debug log buffer
//      what prewarm actually did this session.

import { bqeClient } from './client';
import { isTokenExpiringWithin } from './auth';
import { useAuthStore } from '../../store/useAuthStore';

const DEFAULT_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 60 * 1000;

export interface PrewarmOptions {
  refreshThresholdMs?: number;
  debounceMs?: number;
}

// Module-scoped state for debounce + single-flight. Resets to zero/null on
// JS bundle reload (every cold start), which is the correct behavior — a
// fresh JS context warrants a fresh warmup.
let lastPrewarmAt = 0;
let inFlight: Promise<void> | null = null;

export async function prewarmBqeConnection(opts: PrewarmOptions = {}): Promise<void> {
  const refreshThresholdMs = opts.refreshThresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  // Single-flight: if a prewarm is already running, ride along the same
  // promise. Logged so we can tell from production logs whether multiple
  // call sites are firing on the same lifecycle event.
  if (inFlight) {
    console.log('[jot:prewarm] skipped — already in-flight');
    return inFlight;
  }

  // Debounce: skip if the last successful prewarm was recent.
  const now = Date.now();
  if (lastPrewarmAt > 0 && now - lastPrewarmAt < debounceMs) {
    const ageMs = now - lastPrewarmAt;
    console.log(`[jot:prewarm] skipped — debounced (last completed ${ageMs}ms ago)`);
    return;
  }

  inFlight = (async () => {
    const start = Date.now();
    const store = useAuthStore.getState();
    const tokens = store.tokens;

    // No tokens at this point = a wiring problem. The launch hook's job
    // is to await loadStoredTokens() before calling prewarm; if we see
    // this line at cold-start it means either the await isn't actually
    // waiting (e.g. fire-and-forget pattern that escaped review) or the
    // user has no stored tokens (logged out — expected, but worth a
    // console.warn so the line is colored differently in the log viewer).
    if (!tokens) {
      console.warn('[jot:prewarm] skipped — no tokens loaded yet');
      // Don't update lastPrewarmAt — let the next call try again. The
      // typical scenario here is "user about to log in" and we want
      // prewarm to fire as soon as tokens land.
      return;
    }

    // Demo mode tokens are 1-year-valid and the endpoint isn't a real
    // BQE host, so a warmup GET would just fail. Skip cleanly.
    if (store.demoMode) {
      console.log('[jot:prewarm] skipped — demo mode');
      // Update debounce so rapid AppState toggles in demo don't spam logs.
      lastPrewarmAt = Date.now();
      return;
    }

    let refreshed = false;
    if (isTokenExpiringWithin(tokens, refreshThresholdMs)) {
      // BQE Native client config doesn't return refresh_token (see
      // services/bqe/auth.ts SCOPES). For those sessions, prewarm has
      // nothing to do when the token is expiring — calling refreshTokens
      // would throw, and logging out from a fire-and-forget warmup
      // would kick off an unexpected OAuth re-login from a quiet code
      // path. Bail with a clear log; the isAuthenticated derivation
      // (deriveAuthenticated in useAuthStore) already returns false for
      // this state, so the route guard sends the user to login.
      if (!tokens.refreshToken) {
        console.log(
          '[jot:prewarm] skipped — token expired and no refresh capability ' +
            '(user will be redirected to login)',
        );
        return;
      }
      try {
        await store.refreshTokens();
        refreshed = true;
      } catch (err) {
        // Refresh genuinely failed despite having a refresh_token —
        // network or server-side problem, or the refresh_token itself
        // is now invalid. Match the reactive 401 path: bounce to login.
        console.warn(
          '[jot:prewarm] token refresh failed — logging out:',
          err instanceof Error ? err.message : err,
        );
        await store.logout('session_expired');
        return;
      }
    }

    try {
      // Lightweight warmup GET. /project?fields=id&page=1,1 returns at most
      // one row with a single field — minimal payload, exercises the full
      // TLS + auth + tenant-endpoint resolution path. Uses /project (which a
      // standard timekeeper can read to log time against) rather than
      // /employee, whose roster list is admin-gated and 403s for non-admin
      // users — the warmup must never fail on a permission the app doesn't
      // otherwise need.
      await bqeClient.get('/project', {
        params: { fields: 'id', page: '1,1' },
      });
    } catch (err) {
      // Don't throw — the offline queue handles "real" failures when the
      // user actually saves. We just wanted to warm the path.
      console.warn(
        '[jot:prewarm] warmup GET failed (network unreachable?):',
        err instanceof Error ? err.message : err,
      );
    }

    lastPrewarmAt = Date.now();
    const ms = lastPrewarmAt - start;
    console.log(`[jot:prewarm] completed in ${ms}ms (refreshed: ${refreshed})`);
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Test/diagnostic helper: reset the debounce state. Not used by the app
 * directly but lets a future "Force re-sync" debug action force the next
 * prewarm without waiting out the 60s window.
 */
export function resetPrewarmDebounce(): void {
  lastPrewarmAt = 0;
}
