import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

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
  console.log('[jot:auth] env clientSecret present =', !!process.env.EXPO_PUBLIC_BQE_CLIENT_SECRET);
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

export function getAuthRequestConfig(): AuthSession.AuthRequestConfig {
  return {
    clientId,
    clientSecret,
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
      clientSecret,
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
    { clientId, clientSecret, refreshToken, scopes: SCOPES },
    discovery,
  );
  return tokenResponseToStored({ ...result, ...(result as any).rawResponse });
}

export async function storeTokens(tokens: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

export async function loadTokens(): Promise<StoredTokens | null> {
  const raw = await SecureStore.getItemAsync(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_STORAGE_KEY);
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expiresAt - EXPIRY_BUFFER_MS;
}

export function decodeIdTokenSub(idToken: string): string | null {
  try {
    const [, payload] = idToken.split('.');
    if (!payload) return null;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const claims = JSON.parse(json);
    return claims.sub ?? null;
  } catch {
    return null;
  }
}
