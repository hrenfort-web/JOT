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

// `offline_access` is intentionally omitted. BQE support confirmed Native apps
// don't get refresh tokens for security reasons — that scope causes BQE to
// reject the auth request as `unauthorized_client`. Trade-off: access tokens
// expire ~hourly, after which the user is bounced back to the login screen
// (the 401 interceptor in client.ts handles this gracefully via
// logout('session_expired')).
//
// TODO: Decide before broader rollout whether to:
//   (A) Accept hourly re-auth — simpler, no infra changes, current behavior.
//   (B) Stand up a server-side proxy (e.g. Supabase Edge Function) registered
//       as a Regular Web App in BQE. The server holds the refresh token, the
//       client gets short-lived session JWTs. Adds infra; removes re-auth pain.
export const SCOPES = ['read:core', 'readwrite:core', 'openid'];

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

// BQE Native apps are public OAuth clients — no client_secret. PKCE alone
// authenticates the token exchange. Earlier builds plumbed a clientSecret
// env var through, but it was always empty in practice and BQE ignored it.
// Removed to stop shipping a placeholder env var into the JS bundle.
export function getAuthRequestConfig(): AuthSession.AuthRequestConfig {
  return {
    clientId,
    scopes: SCOPES,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
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

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier?: string,
): Promise<StoredTokens> {
  const result = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code,
      redirectUri,
      extraParams: codeVerifier ? { code_verifier: codeVerifier } : undefined,
    },
    discovery,
  );
  const stored = tokenResponseToStored({ ...result, ...(result as any).rawResponse });
  if (!stored.endpoint) {
    throw new Error('Token response missing endpoint field');
  }
  return stored;
}

export async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  const result = await AuthSession.refreshAsync(
    { clientId, refreshToken, scopes: SCOPES },
    discovery,
  );
  return tokenResponseToStored({ ...result, ...(result as any).rawResponse });
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
