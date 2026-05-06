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
import {
  DEMO_ACCESS_TOKEN,
  DEMO_EMPLOYEE,
  DEMO_ENDPOINT,
  clearDemoData,
  seedDemoData,
} from '../services/demo/seedData';

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
    await storeTokens(tokens);
    set({
      tokens,
      baseUrl: tokens.endpoint,
      user,
      isAuthenticated: true,
      sessionExpired: false,
      demoMode: false,
    });
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
      isAuthenticated: true,
      sessionExpired: false,
      demoMode: true,
    });
  },

  logout: async (reason = 'manual') => {
    const wasDemo = get().demoMode;
    if (wasDemo) {
      await clearDemoData();
    } else {
      await clearTokens();
    }
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
