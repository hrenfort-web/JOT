import { create } from 'zustand';
import {
  loadScanConsentAcceptedAt,
  saveScanConsentAcceptedAt,
} from '../utils/preferences';

/**
 * In-memory mirror of the per-device scanConsentAcceptedAt preference, so
 * the Scan tab can gate synchronously once loaded. Same shape as
 * useReminderStore: the preference module owns persistence, this store
 * owns reactivity.
 *
 * declinedThisSession is deliberately NOT persisted: it only stops the Scan
 * tab from re-opening the consent modal on every focus after the user
 * chose "Not now". Next launch starts clean and the gate shows again.
 */
interface ScanConsentState {
  acceptedAt: string | null;
  isLoaded: boolean;
  declinedThisSession: boolean;

  load: () => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  clearDecline: () => void;
}

export const useScanConsentStore = create<ScanConsentState>((set, get) => ({
  acceptedAt: null,
  isLoaded: false,
  declinedThisSession: false,

  load: async () => {
    if (get().isLoaded) return;
    const acceptedAt = await loadScanConsentAcceptedAt();
    set({ acceptedAt, isLoaded: true });
  },

  accept: async () => {
    const now = new Date().toISOString();
    set({ acceptedAt: now, isLoaded: true, declinedThisSession: false });
    await saveScanConsentAcceptedAt(now);
  },

  decline: () => set({ declinedThisSession: true }),

  clearDecline: () => set({ declinedThisSession: false }),
}));
