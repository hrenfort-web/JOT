import { create } from 'zustand';
import {
  StoredTokens,
  clearTokens,
  isTokenExpired,
  loadTokens,
  refreshAccessToken,
  storeTokens,
} from '../services/bqe/auth';
import type { BqeEmployee } from '../services/bqe/employee';

export type LogoutReason = 'manual' | 'session_expired';

interface AuthState {
  isReady: boolean;
  isAuthenticated: boolean;
  sessionExpired: boolean;
  user: BqeEmployee | null;
  tokens: StoredTokens | null;
  baseUrl: string | null;

  login: (tokens: StoredTokens, user: BqeEmployee) => Promise<void>;
  logout: (reason?: LogoutReason) => Promise<void>;
  refreshTokens: () => Promise<void>;
  loadStoredTokens: () => Promise<void>;
  clearSessionExpired: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isReady: false,
  isAuthenticated: false,
  sessionExpired: false,
  user: null,
  tokens: null,
  baseUrl: null,

  login: async (tokens, user) => {
    await storeTokens(tokens);
    set({
      tokens,
      baseUrl: tokens.endpoint,
      user,
      isAuthenticated: true,
      sessionExpired: false,
    });
  },

  logout: async (reason = 'manual') => {
    await clearTokens();
    set({
      tokens: null,
      baseUrl: null,
      user: null,
      isAuthenticated: false,
      sessionExpired: reason === 'session_expired',
    });
  },

  clearSessionExpired: () => set({ sessionExpired: false }),

  refreshTokens: async () => {
    const { tokens } = get();
    if (!tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }
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
    await storeTokens(merged);
    set({ tokens: merged, baseUrl: merged.endpoint });
  },

  loadStoredTokens: async () => {
    try {
      const tokens = await loadTokens();
      if (!tokens) {
        set({ isReady: true });
        return;
      }
      set({ tokens, baseUrl: tokens.endpoint, isAuthenticated: true });
      if (isTokenExpired(tokens) && tokens.refreshToken) {
        try {
          await get().refreshTokens();
        } catch {
          await get().logout('session_expired');
        }
      }
    } finally {
      set({ isReady: true });
    }
  },
}));
