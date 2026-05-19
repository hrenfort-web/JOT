import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
// Type-only import — no runtime cycle with employee.ts (which imports
// auth at runtime via decodeIdTokenSub). TS erases type-only imports
// from the emitted JS.
import type { BqeEmployee } from './employee';

// BQE Core OIDC base URL — confirmed from BQEDeveloper/CoreApiPythonSample/config.ini.
// Earlier code used `https://api-login.bqe.com` which doesn't resolve — Safari surfaces
// that as "couldn't establish a secure connection."
const BQE_IDP_BASE = 'https://api-identity.bqecore.com/idp';

export const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `${BQE_IDP_BASE}/connect/authorize`,
  tokenEndpoint: `${BQE_IDP_BASE}/connect/token`,
  revocationEndpoint: `${BQE_IDP_BASE}/connect/revocation`,
};

// BQE has migrated Jot's registration from Native App to Regular Web App,
// which in principle supports refresh tokens via the `offline_access` scope.
// All Phase 2 / Phase 3 plumbing (client_secret, Basic auth on the token
// endpoint, raw-fetch exchange + refresh, 15s timeout, 5xx retry, revocation
// on manual logout) is already in place and tested — it activates the moment
// `offline_access` is in the SCOPES array AND BQE actually grants the scope.
//
// `offline_access` is TEMPORARILY OMITTED because BQE's authorize endpoint
// currently rejects every request containing it for this specific client
// (i7vwtYLmeXDGc1r_x6ijYigUev9ECEnq.apps.bqe.com), even though the portal
// display lists the scope as available. Verified via Phase 3.5 diagnostic
// on 2026-05-18 — BQE x-correlation-id of one rejected request:
// fa765030-5960-419b-bf15-e10ab7837a14. Authorize endpoint redirects to
// /idp/home/error?errorId=… whenever offline_access is present; redirects
// to /idp/Account/Login (the success path) whenever it's absent. Filed with
// Nasiha at BQE Support — Request Id 4001a001-0001-f700-b63f-84710c7967bb.
//
// When BQE enables `offline_access` server-side for this client, the only
// code change required is adding 'offline_access' back to the SCOPES array
// below — every other piece is already wired up.
//
// Trade-off accepted: client_secret ships in the JS bundle (.env →
// EXPO_PUBLIC_BQE_CLIENT_SECRET). Acceptable for the single-tenant pilot;
// a future server-side proxy is the long-term answer for multi-tenant.
export const SCOPES = ['read:core', 'readwrite:core', 'openid', 'offline_access'];

export const redirectUri = AuthSession.makeRedirectUri({
  scheme: 'jot',
  path: 'oauth/callback',
});

if (__DEV__) {
  const envClientId = process.env.EXPO_PUBLIC_BQE_CLIENT_ID ?? '';
  console.log('[jot:auth] redirectUri =', redirectUri);
  console.log('[jot:auth] authorizationEndpoint =', discovery.authorizationEndpoint);
  console.log('[jot:auth] tokenEndpoint =', discovery.tokenEndpoint);
  console.log(
    '[jot:auth] env clientId length =',
    envClientId.length,
    'endsWith ".apps.bqe.com" =',
    envClientId.endsWith('.apps.bqe.com'),
  );
  console.log('[jot:auth] scopes =', SCOPES.join(' '));
}

const TOKEN_STORAGE_KEY = 'bqe_oauth_tokens';
const EXPIRY_BUFFER_MS = 60_000;

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType: string;
  expiresAt: number;
  endpoint: string;
}

const clientId = process.env.EXPO_PUBLIC_BQE_CLIENT_ID ?? '';
const clientSecret = process.env.EXPO_PUBLIC_BQE_CLIENT_SECRET ?? '';

if (!clientSecret) {
  console.warn(
    '[jot:auth] EXPO_PUBLIC_BQE_CLIENT_SECRET is empty — token exchange and refresh will fail. ' +
      'Set it in .env (Web App registration requires the client secret via HTTP Basic auth).',
  );
}

// BQE migrated Jot's registration to Regular Web App, which means the token
// endpoint authenticates via HTTP Basic auth using clientId:clientSecret
// (RFC 6749 §2.3.1). PKCE is DROPPED: BQE's Web App registration treats the
// client as confidential and rejects PKCE on the authorize step with
// `error=unauthorized_client` (observed live after the Phase 2 commit landed
// with PKCE still enabled). Standard OAuth 2.1 separation: confidential
// clients use client_secret, public clients use PKCE — not both.
//
// This contradicts BQE's Swift sample (which sends client_secret AND
// code_verifier together), but that sample is a Native App reference and
// doesn't apply to our Web App registration. The authoritative reference
// for this registration is bqe-test/auth.mjs which explicitly omits PKCE
// and has been verified end-to-end against the same /connect/token endpoint
// — that's the shape we mirror.
//
// expo-auth-session still handles the browser-pop on the authorize step;
// the token endpoint round-trip is done with raw fetch (see
// exchangeCodeForTokens / refreshAccessToken) because we have verified
// evidence (bqe-test/*.mjs) that raw fetch + Basic auth works against
// BQE's Web App token endpoint, and no evidence that expo-auth-session
// sends credentials in the shape BQE's confidential-client registration
// expects.
export function getAuthRequestConfig(): AuthSession.AuthRequestConfig {
  return {
    clientId,
    scopes: SCOPES,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: false,
  };
}

function tokenResponseToStored(raw: any): StoredTokens {
  const expiresIn = Number(raw.expires_in ?? raw.expiresIn ?? 3600);
  const rawEndpoint = (raw.endpoint ?? raw.api_endpoint ?? '') as string;
  return {
    accessToken: raw.access_token ?? raw.accessToken,
    refreshToken: raw.refresh_token ?? raw.refreshToken,
    idToken: raw.id_token ?? raw.idToken,
    tokenType: raw.token_type ?? raw.tokenType ?? 'Bearer',
    expiresAt: Date.now() + expiresIn * 1000,
    endpoint: rawEndpoint.replace(/\/+$/, ''),
  };
}

export async function fetchUserInfo(
  accessToken: string,
): Promise<Record<string, unknown>> {
  const url = `${BQE_IDP_BASE}/connect/userinfo`;
  if (__DEV__) console.log('[jot:auth] -> GET userinfo', url);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (__DEV__) {
      console.log('[jot:auth] <- userinfo', response.status, text.slice(0, 300));
    }
    throw new Error(`userinfo ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (__DEV__) {
    console.log('[jot:auth] <- userinfo 200');
    console.log('[jot:auth]    claims =', data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Token endpoint round-trips
// ---------------------------------------------------------------------------
// All token-endpoint POSTs go through raw fetch with HTTP Basic auth, modeled
// on bqe-test/{auth,refresh}.mjs (those scripts are verified working against
// BQE's Web App registration). expo-auth-session's exchangeCodeAsync /
// refreshAsync are deliberately NOT used here — they're untested against
// BQE's confidential-client credential shape, and the Node scripts give us
// known-good evidence to mirror.

export class RefreshTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Token refresh timed out after ${timeoutMs}ms`);
    this.name = 'RefreshTimeoutError';
  }
}

const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_RETRY_DELAY_MS = 500;

function basicAuthHeader(): string {
  // btoa is available in React Native / Hermes. The raw "id:secret" string
  // is ASCII (BQE client IDs are alphanumeric + dots; secrets are
  // base64url-style strings) so a UTF-16 → btoa round-trip is safe.
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${btoa(credentials)}`;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

export async function exchangeCodeForTokens(
  code: string,
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(discovery.tokenEndpoint as string, {
    method: 'POST',
    headers: {
      authorization: basicAuthHeader(),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const raw = (await res.json()) as Record<string, unknown>;

  // Temporary — remove once offline_access verified working (see handoff)
  const grantedScope = typeof raw.scope === 'string' ? raw.scope : '';
  const grantedScopes = grantedScope.length > 0 ? grantedScope.split(' ') : [];
  const refreshTokenRaw = typeof raw.refresh_token === 'string' ? raw.refresh_token : '';
  console.log('[BQE-OFFLINE-ACCESS-VERIFY] granted scopes:', grantedScopes);
  console.log('[BQE-OFFLINE-ACCESS-VERIFY] hasRefreshToken:', refreshTokenRaw.length > 0);
  console.log('[BQE-OFFLINE-ACCESS-VERIFY] refresh_token length:', refreshTokenRaw.length);

  const stored = tokenResponseToStored(raw);
  if (!stored.endpoint) {
    throw new Error('Token response missing endpoint field');
  }
  return stored;
}

export async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  // One-retry-on-5xx wrapper — the request-level retry budget in client.ts
  // covers BQE API endpoints, NOT the token endpoint. Without this, a
  // transient 503 on /connect/token forces an immediate logout. Cap is hard
  // at one retry: looping a hung refresh path is worse than a clean failure.
  const attempt = async (): Promise<Response> => {
    const fetchPromise = fetch(discovery.tokenEndpoint as string, {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });

    // 15s timeout — without this, a hung token endpoint blocks the
    // single-flight refresh promise in client.ts forever, which in turn
    // blocks every queued retry. Reject with RefreshTimeoutError so callers
    // can distinguish "BQE is slow" from "BQE rejected our refresh".
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RefreshTimeoutError(REFRESH_TIMEOUT_MS));
      }, REFRESH_TIMEOUT_MS);
      fetchPromise.then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  };

  let res = await attempt();
  if (res.status >= 500 && res.status < 600) {
    console.warn(
      `[jot:auth] refresh got ${res.status} from token endpoint — retrying once after ${REFRESH_RETRY_DELAY_MS}ms`,
    );
    await new Promise((r) => setTimeout(r, REFRESH_RETRY_DELAY_MS));
    res = await attempt();
  }

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const raw = (await res.json()) as Record<string, unknown>;
  const stored = tokenResponseToStored(raw);
  // BQE may not echo refresh_token back if it isn't rotating it on this
  // exchange — preserve the caller's previous refresh_token in that case.
  // Mirror bqe-test/refresh.mjs:77.
  if (!stored.refreshToken) {
    stored.refreshToken = refreshToken;
  }
  // BQE may also not echo `endpoint` on refresh — the store-level merge in
  // useAuthStore.refreshTokens preserves it, but defend in the helper too
  // so any future caller path stays correct.
  // (No `endpoint`-fallback here: stored.endpoint already comes from
  // tokenResponseToStored, which returns '' if absent — the store layer
  // preserves the prior value when stored.endpoint is empty.)
  return stored;
}

/**
 * Fire-and-forget revocation of the user's tokens at BQE. Called from
 * logout('manual') only — session_expired logouts skip revocation because
 * the token is already invalid. Errors are caught and logged; never thrown
 * to the caller. The local logout proceeds regardless.
 *
 * Prefers revoking the refresh_token (broader: kills the entire session) over
 * the access_token (just kills the current short-lived token).
 */
export async function revokeTokens(
  accessToken: string,
  refreshToken?: string,
): Promise<void> {
  // Discovery doesn't always carry revocationEndpoint at runtime; fall back
  // to the BQE-known URL. Both paths target the same endpoint string today.
  const url =
    discovery.revocationEndpoint ?? `${BQE_IDP_BASE}/connect/revocation`;

  const targetToken = refreshToken ?? accessToken;
  const tokenTypeHint = refreshToken ? 'refresh_token' : 'access_token';

  const body = new URLSearchParams({
    token: targetToken,
    token_type_hint: tokenTypeHint,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await readErrorBody(res);
      console.warn(
        `[jot:auth] revokeTokens non-2xx (${res.status}) — local logout proceeds: ${text}`,
      );
    } else {
      console.log(`[jot:auth] revokeTokens OK (${tokenTypeHint})`);
    }
  } catch (err) {
    console.warn(
      '[jot:auth] revokeTokens failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Persist the token bundle. Callers must pass a `reason` so the Debug
 * log buffer shows WHY tokens were re-stored ("initial-login", "refresh",
 * etc.) — useful for spotting "wait, why did storeTokens fire on a
 * normal cold launch?" patterns in production logs.
 *
 * Also writes a one-time round-trip sanity log: immediately reads back
 * the just-written payload and confirms expiresAt + refresh_token
 * survived intact. This catches silent SecureStore truncation on
 * over-2048-byte writes (the warning is soft, but if the data does get
 * truncated we want to see it directly in the logs rather than infer it
 * from downstream failures).
 */
export async function storeTokens(
  tokens: StoredTokens,
  reason: string,
): Promise<void> {
  const payload = JSON.stringify(tokens);
  const byteSize = byteLength(payload);
  // Always log the call (including reason). The >=2048 path gets a warn
  // for log-viewer colour; the normal path logs at info level.
  if (byteSize >= 2048) {
    console.warn(
      `[jot:auth] storeTokens called — reason: ${reason}, bytes: ${byteSize} ` +
        `(access_token: ${tokens.accessToken?.length ?? 0} chars, ` +
        `id_token: ${tokens.idToken?.length ?? 0} chars, ` +
        `refresh_token: ${tokens.refreshToken?.length ?? 0} chars) ` +
        `— over SecureStore soft limit`,
    );
  } else {
    console.log(`[jot:auth] storeTokens called — reason: ${reason}, bytes: ${byteSize}`);
  }
  await SecureStore.setItemAsync(TOKEN_STORAGE_KEY, payload);

  // Round-trip sanity check. Reads the value right back and confirms the
  // critical fields are present. Adds ~5-15ms but only fires on writes
  // (not on every request); the diagnostic value is worth the cost while
  // we're chasing cold-start perf.
  try {
    const readback = await SecureStore.getItemAsync(TOKEN_STORAGE_KEY);
    if (readback === null) {
      console.warn('[jot:auth] round-trip FAILED — readback was null');
    } else {
      const readbackBytes = byteLength(readback);
      let parsed: Partial<StoredTokens> | null = null;
      try {
        parsed = JSON.parse(readback) as Partial<StoredTokens>;
      } catch (e) {
        console.warn(
          `[jot:auth] round-trip parse FAILED — wrote ${byteSize} bytes, read ${readbackBytes} bytes:`,
          e instanceof Error ? e.message : e,
        );
      }
      if (parsed) {
        const expiresAtPresent = typeof parsed.expiresAt === 'number';
        const refreshTokenPresent = typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0;
        console.log(
          `[jot:auth] round-trip OK — wrote ${byteSize}, read ${readbackBytes}, ` +
            `expiresAt: ${expiresAtPresent}, refresh_token: ${refreshTokenPresent}`,
        );
      }
    }
  } catch (e) {
    console.warn(
      '[jot:auth] round-trip readback errored (non-fatal):',
      e instanceof Error ? e.message : e,
    );
  }
}

// UTF-8 byte length without pulling Buffer in (RN's TextEncoder is the
// portable option). Used for the SecureStore size guard above.
function byteLength(s: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TE: any = (globalThis as any).TextEncoder;
  if (typeof TE === 'function') {
    return new TE().encode(s).length;
  }
  // Fallback: approximate via char count (correct for ASCII; OAuth JWTs
  // are all ASCII so this is exact for our payload).
  return s.length;
}

export async function loadTokens(): Promise<StoredTokens | null> {
  const t0 = Date.now();
  const raw = await SecureStore.getItemAsync(TOKEN_STORAGE_KEY);
  if (!raw) {
    console.log(`[jot:auth] loadTokens — no stored tokens (read in ${Date.now() - t0}ms)`);
    return null;
  }
  const rawBytes = byteLength(raw);
  let parsed: StoredTokens | null = null;
  try {
    parsed = JSON.parse(raw) as StoredTokens;
  } catch (e) {
    console.warn(
      `[jot:auth] loadTokens — JSON parse FAILED on ${rawBytes} bytes:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
  // Enumerate fields actually present so we can spot when a write dropped
  // something. Specifically call out expiresAt + refreshToken (the two
  // fields most likely to be missing in a broken bundle).
  const fields = Object.keys(parsed).join(',');
  const expiresAtPresent = typeof parsed.expiresAt === 'number';
  const refreshTokenPresent = typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0;
  console.log(
    `[jot:auth] loadTokens — read ${rawBytes} bytes in ${Date.now() - t0}ms, fields: [${fields}], ` +
      `expiresAt present: ${expiresAtPresent}, refresh_token present: ${refreshTokenPresent}`,
  );
  return parsed;
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_STORAGE_KEY);
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expiresAt - EXPIRY_BUFFER_MS;
}

/**
 * Configurable-buffer expiry check. Returns true when the token will be
 * expired within `withinMs` from now. Used by prewarm (10-minute threshold
 * for opportunistic refresh) and the write-method request interceptor
 * (5-minute threshold for proactive refresh before POST/PUT/DELETE).
 */
export function isTokenExpiringWithin(tokens: StoredTokens, withinMs: number): boolean {
  return Date.now() >= tokens.expiresAt - withinMs;
}

/**
 * Decode the payload section of a JWT without verifying the signature or
 * expiry. Returns the parsed claims object or null on any failure.
 *
 * Safe to use against tokens we just received from BQE — we trust the
 * channel (HTTPS to api-identity.bqecore.com), and we use these claims
 * only to populate display data, never for authorization decisions
 * (those go through the access token + BQE-side enforcement).
 */
function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  try {
    const [, payload] = idToken.split('.');
    if (!payload) return null;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const claims = JSON.parse(json);
    return typeof claims === 'object' && claims !== null
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function decodeIdTokenSub(idToken: string): string | null {
  const claims = decodeIdTokenPayload(idToken);
  if (!claims) return null;
  const sub = claims.sub;
  return typeof sub === 'string' ? sub : null;
}

// -------------------------------------------------------------------------
// Persisted user object (separate SecureStore entry)
// -------------------------------------------------------------------------
//
// Why separate from the token bundle:
//   1. The token entry is already 2502 bytes — over expo-secure-store's
//      2048-byte soft limit. Adding user JSON to it would push deeper
//      into iOS Keychain territory we don't want to test.
//   2. The BQE-resolved user (id = the *resourceId*, returned by
//      /employee + userinfo's `user_id`) is a different UUID than the
//      id_token's `sub` claim. We can't derive it from anything in the
//      token bundle — we have to persist it explicitly.
//   3. Tokens rotate (on refresh); the user object is stable across the
//      whole session and across stored-token relaunches. Different
//      write cadences want different storage keys.
//
// First-time migration note: existing installs have stored tokens but no
// stored user yet. Their first relaunch after this code ships will
// loadStoredUser() → null and the home bootstrap will stay idle until
// they log in once more. After that login, storeCurrentUser persists the
// resolved user and subsequent relaunches work normally. H is the only
// existing user; one extra login is acceptable.

const USER_STORAGE_KEY = 'jot.currentUser';

export async function storeCurrentUser(user: BqeEmployee): Promise<void> {
  await SecureStore.setItemAsync(USER_STORAGE_KEY, JSON.stringify(user));
}

export async function loadStoredUser(): Promise<BqeEmployee | null> {
  const raw = await SecureStore.getItemAsync(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BqeEmployee;
    if (typeof parsed?.id !== 'string' || parsed.id.length === 0) {
      // Defensive: a malformed stored object (missing id) is useless —
      // treat as no stored user.
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearStoredUser(): Promise<void> {
  await SecureStore.deleteItemAsync(USER_STORAGE_KEY);
}
