import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

export const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://api-login.bqe.com/authorize',
  tokenEndpoint: 'https://api-login.bqe.com/token',
};

export const SCOPES = ['read:core', 'readwrite:core', 'openid', 'offline_access'];

export const redirectUri = AuthSession.makeRedirectUri({
  scheme: 'jot',
  path: 'oauth/callback',
});

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
  return {
    accessToken: raw.access_token ?? raw.accessToken,
    refreshToken: raw.refresh_token ?? raw.refreshToken,
    idToken: raw.id_token ?? raw.idToken,
    tokenType: raw.token_type ?? raw.tokenType ?? 'Bearer',
    expiresAt: Date.now() + expiresIn * 1000,
    endpoint: raw.endpoint ?? raw.api_endpoint ?? '',
  };
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
