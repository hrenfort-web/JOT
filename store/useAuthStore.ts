import { create } from 'zustand';
import {
  StoredTokens,
  clearStoredUser,
  clearTokens,
  isTokenExpired,
  loadStoredUser,
  loadTokens,
  refreshAccessToken,
  storeCurrentUser,
  storeTokens,
} from '../services/bqe/auth';

/**
 * Derive isAuthenticated from the stored tokens.
 *
 * The point: "authenticated" should mean "we can make a BQE call right
 * now (or recover from a 401)" — not just "we have a token bundle".
 *
 * Cases:
 *   - no tokens                              → false (need to log in)
 *   - tokens present, not expired            → true
 *   - tokens present, expired, has refresh   → true (we can refresh)
 *   - tokens present, expired, no refresh    → false (need to log in)
 *
 * The third case applies to long-lived sessions where we still have an
 * unexpired refresh_token. The fourth case is the BQE Native client
 * path: no offline_access scope = no refresh_token ever, so an expired
 * token is unrecoverable. Pre-fix, isAuthenticated returned true here
 * and prewarm tried (and failed) to refresh, then logged out — kicking
 * off a confused OAuth re-login dance. With this derivation, the route
 * guard sends the user straight to login.
 */
function deriveAuthenticated(tokens: StoredTokens | null): boolean {
  if (!tokens) return false;
  if (!isTokenExpired(tokens)) return true;
  return !!tokens.refreshToken;
}
import type { BqeEmployee } from '../services/bqe/employee';
import {
  DEMO_ACCESS_TOKEN,
  DEMO_EMPLOYEE,
  DEMO_ENDPOINT,
  clearDemoData,
  seedDemoData,
} from '../services/demo/seedData';
import { runInitialSync } from '../services/sync/initialSync';

export type LogoutReason = 'manual' | 'session_expired';

interface AuthState {
  isReady: boolean;
  isAuthenticated: boolean;
  sessionExpired: boolean;
  demoMode: boolean;
  user: BqeEmployee | null;
  tokens: StoredTokens | null;
  baseUrl: string | null;

  login: (tokens: StoredTokens, user: BqeEmployee) => Promise<void>;
  loginAsDemo: () => Promise<void>;
  logout: (reason?: LogoutReason) => Promise<void>;
  refreshTokens: () => Promise<void>;
  loadStoredTokens: () => Promise<void>;
  clearSessionExpired: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isReady: false,
  isAuthenticated: false,
  sessionExpired: false,
  demoMode: false,
  user: null,
  tokens: null,
  baseUrl: null,

  login: async (tokens, user) => {
    await storeTokens(tokens, 'initial-login');

    // Wipe any leftover demo rows from a prior Explore Demo session before we
    // hydrate the cache with real BQE data. Each row is keyed by `bqeId LIKE
    // 'demo-%'` so this only touches demo data; real BQE rows are unaffected.
    await clearDemoData();

    set({
      tokens,
      baseUrl: tokens.endpoint,
      user,
      isAuthenticated: deriveAuthenticated(tokens),
      sessionExpired: false,
      demoMode: false,
    });

    // Persist the resolved user (BQE-side resourceId in `user.id`) so the
    // next stored-token relaunch can rehydrate the home screen's user
    // gate without another /employee round-trip. Fire-and-forget: a
    // SecureStore hiccup shouldn't block login, but log so we can spot
    // it. Important: this is the BQE-resolved user (with the real
    // resourceId, e.g. 0da01f5a-…), NOT the id_token's `sub` (which is
    // a different UUID — the IdP's internal user id — and would 404 on
    // every downstream /employee call).
    storeCurrentUser(user)
      .then(() => {
        console.log(
          `[jot:auth] persisted user — id=${user.id}, displayName="${user.displayName ?? ''}"`,
        );
      })
      .catch((e) => {
        console.warn(
          '[jot:auth] storeCurrentUser failed (login still succeeded):',
          e instanceof Error ? e.message : e,
        );
      });

    // Force a fresh sync of projects/activities/employees so the home screen
    // doesn't fall back to whatever was in SQLite. If the network or any
    // single endpoint fails, the home screen's bootstrap effect will retry on
    // mount; we don't want to block login on a sync hiccup.
    try {
      await runInitialSync();
    } catch (e) {
      if (__DEV__) console.log('[jot:auth] post-login sync failed:', e);
    }
  },

  loginAsDemo: async () => {
    await seedDemoData();
    const tokens: StoredTokens = {
      accessToken: DEMO_ACCESS_TOKEN,
      tokenType: 'Bearer',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      endpoint: DEMO_ENDPOINT,
    };
    set({
      tokens,
      baseUrl: tokens.endpoint,
      user: DEMO_EMPLOYEE,
      // Demo tokens are 1-year-valid (see seedData) — deriveAuthenticated
      // returns true unconditionally for them, but route through the
      // helper for consistency rather than hard-coding true.
      isAuthenticated: deriveAuthenticated(tokens),
      sessionExpired: false,
      demoMode: true,
    });
  },

  logout: async (reason = 'manual') => {
    // Always run all three cleanups so switching between real and demo
    // mode never leaves stale tokens in SecureStore, a stale persisted
    // user object (which would resurrect "Hi, Hadyn" on the login
    // screen after a fresh launch), or stale demo rows in SQLite.
    // Each is a no-op when there's nothing to clean.
    await Promise.all([clearTokens(), clearStoredUser(), clearDemoData()]);
    set({
      tokens: null,
      baseUrl: null,
      user: null,
      isAuthenticated: false,
      sessionExpired: reason === 'session_expired',
      demoMode: false,
    });
  },

  clearSessionExpired: () => set({ sessionExpired: false }),

  refreshTokens: async () => {
    const { tokens } = get();
    if (!tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }
    const t0 = Date.now();
    console.log('[jot:auth] refreshTokens START');
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    const merged: StoredTokens = {
      ...tokens,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      idToken: refreshed.idToken ?? tokens.idToken,
      tokenType: refreshed.tokenType,
      expiresAt: refreshed.expiresAt,
      endpoint: refreshed.endpoint || tokens.endpoint,
    };
    await storeTokens(merged, 'refresh');
    set({
      tokens: merged,
      baseUrl: merged.endpoint,
      isAuthenticated: deriveAuthenticated(merged),
    });
    console.log(`[jot:auth] refreshTokens END — ${Date.now() - t0}ms`);
  },

  loadStoredTokens: async () => {
    const t0 = Date.now();
    console.log('[jot:auth] loadStoredTokens START');
    try {
      const tokens = await loadTokens();
      if (!tokens) {
        console.log('[jot:auth] loadStoredTokens: no tokens in SecureStore');
        set({ isReady: true });
        return;
      }
      // Hydrate `user` from the separate SecureStore entry written by
      // login(). The home screen's bootstrap effect is gated on
      // user?.id, so without this the relaunch path renders "Hi there"
      // with a stuck spinner.
      //
      // The id_token's `sub` claim is NOT used here — it's the IdP's
      // internal user id, a different UUID than BQE's resourceId. Using
      // sub would 404 every /employee call and 409 every /timeentry
      // POST. The persisted user object carries the actual resourceId
      // resolved by fetchCurrentEmployee at login time.
      //
      // Only loads when the tokens are usable (deriveAuthenticated
      // true). If they're expired with no refresh capability, the route
      // guard will bounce to login anyway; no point reading user.
      const authed = deriveAuthenticated(tokens);
      const storedUser = authed ? await loadStoredUser() : null;
      set({
        tokens,
        baseUrl: tokens.endpoint,
        // Critical: derive from the loaded tokens. Pre-fix this set
        // unconditionally true, so a stored-but-expired-no-refresh
        // token would render "Hi there" and the protected-route guard
        // never fired the redirect-to-login.
        isAuthenticated: authed,
        user: storedUser,
      });
      if (storedUser) {
        console.log(
          `[jot:auth] restored user from secure store — id=${storedUser.id}, ` +
            `displayName="${storedUser.displayName ?? ''}"`,
        );
      } else if (authed) {
        // Tokens are usable but no user is persisted. Happens on first
        // launch after this code ships (existing users have stored
        // tokens but no user entry yet) — one extra login fixes it for
        // good. Home bootstrap stays idle until then.
        console.warn(
          '[jot:auth] no stored user (will require re-login or will hydrate after next OAuth)',
        );
      }
      // Decision-point log: surface the exact comparison driving the
      // refresh-or-not branch. EXPIRY_BUFFER_MS (60s) is baked into
      // isTokenExpired; if we ever miss a refresh because the token
      // expired between this check and the next request, this log will
      // make the timing obvious.
      const expired = isTokenExpired(tokens);
      console.log(
        `[jot:auth] checking expiry: expiresAt=${tokens.expiresAt}, now=${Date.now()}, ` +
          `expired (with 60s buffer)=${expired}, has refresh_token=${!!tokens.refreshToken}`,
      );
      if (expired && tokens.refreshToken) {
        console.log('[jot:auth] decision: refresh because token expired and refresh_token present');
        try {
          await get().refreshTokens();
        } catch (e) {
          console.warn(
            '[jot:auth] refresh on load FAILED — logging out:',
            e instanceof Error ? e.message : e,
          );
          await get().logout('session_expired');
        }
      } else if (expired) {
        // Expired but no refresh_token: nothing we can do, but the request
        // will hit the reactive 401 path which then logs out.
        console.warn(
          '[jot:auth] decision: token expired but no refresh_token — first request will 401 and log out',
        );
      } else {
        console.log('[jot:auth] decision: token still valid, skipping refresh');
      }
    } finally {
      set({ isReady: true });
      console.log(`[jot:auth] loadStoredTokens END — ${Date.now() - t0}ms total`);
    }
  },
}));
