// Sync lifecycle store. Owns the "is a sync in flight, when did the last one
// finish, what's its progress, did it fail" state for the app. The mechanics
// of "what is a sync" stay in services/sync/initialSync.ts — this store wraps
// the service with single-flight semantics, generation-counter cancellation,
// and zustand-subscribable state.
//
// Commit 1 of the Path A refactor (lifting runInitialSync out of HomeScreen's
// bootstrap effect): the store is built but not yet called. Existing direct
// callers of runInitialSync (home bootstrap, useAuthStore.login, settings
// manual sync) remain untouched. They get re-routed through runSync in later
// commits.
//
// `isSyncing` is manually mirrored with `inFlightPromise`; both must stay in sync.
// Do not introduce a derived getter for isSyncing — consumers subscribe to it as
// zustand state and must see it update reactively. The mirror is maintained
// inside runSync's IIFE finally and inside cancelSync.

import { create } from 'zustand';
import {
  runInitialSync,
  getLastSyncTime,
  setLastSyncTime,
  type SyncProgress,
} from '../services/sync/initialSync';

// Module-scope (not zustand state) — these track the current in-flight run
// across the whole module. zustand state mirrors `isSyncing` for subscribers;
// the source of truth for "is anything running" is `inFlightPromise`.
let inFlightPromise: Promise<void> | null = null;
let currentGen = 0;

type SyncReason = 'cold-launch' | 'post-login' | 'manual';

interface SyncState {
  lastSyncAt: Date | null;
  isSyncing: boolean;
  progress: SyncProgress | null;
  lastError: string | null;

  runSync: (reason: SyncReason) => Promise<void>;
  cancelSync: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  lastSyncAt: null,
  isSyncing: false,
  progress: null,
  lastError: null,

  runSync: (reason) => {
    console.log(`[jot:sync-store] runSync reason=${reason}`);
    if (inFlightPromise !== null) {
      // Re-entry: caller gets the existing in-flight run. Awaiting callers
      // wait for it; non-awaiting callers see the same fire-and-forget
      // behavior. This is the contract that lets the post-auth effect
      // (fire-and-forget) and login's await coexist without the second
      // call short-circuiting through.
      console.log(`[jot:sync-store] returning in-flight promise (reason=${reason})`);
      return inFlightPromise;
    }
    console.log(`[jot:sync-store] starting new sync (reason=${reason})`);

    const gen = ++currentGen;
    const isStale = (): boolean => gen !== currentGen;

    set({ isSyncing: true, lastError: null, progress: null });

    const onProgress = (p: SyncProgress): void => {
      // Drop progress updates from a stale run — they'd otherwise overwrite
      // a fresh run's progress state if cancel + re-entry happened mid-flight.
      if (!isStale()) {
        set({ progress: p });
      }
    };

    // Generation-based "are we current?" check. The original spec used
    // promise-identity (`inFlightPromise === myPromise`) but that creates a
    // self-reference TS can't initialize (myPromise is declared by the IIFE
    // whose body references it). The gen check is semantically equivalent:
    // cancelSync bumps currentGen, a fresh runSync bumps it again — so
    // `gen === currentGen` is true iff no cancel/re-entry has happened since
    // we started. Used in finally to decide whether to clear inFlightPromise
    // (don't clobber a fresh run started after our cancel).
    const stillCurrent = (): boolean => gen === currentGen;

    const promise = (async () => {
      let hadError = false;
      try {
        await runInitialSync(onProgress, isStale);
      } catch (e) {
        if (!isStale()) {
          hadError = true;
          const message = e instanceof Error ? e.message : String(e);
          set({ lastError: message });
          console.warn('[jot:sync] runSync failed:', message);
        }
        // If isStale, the run was cancelled — no error to record.
      } finally {
        // Only clear inFlightPromise if we still own it. cancelSync may have
        // nulled it and a fresh run may have replaced it; don't clobber.
        if (stillCurrent()) {
          inFlightPromise = null;
        }
        // Only update isSyncing / lastSyncAt if we're still the current run.
        if (!isStale()) {
          set({ isSyncing: false, progress: null });
          if (!hadError) {
            const now = new Date();
            await setLastSyncTime(now);
            set({ lastSyncAt: now });
          }
        }
      }
    })();

    inFlightPromise = promise;
    return promise;
  },

  // cancelSync clears inFlightPromise immediately rather than letting the IIFE's
  // finally do it. This prevents a corner case where: (a) cancel fires (e.g., on
  // logout), (b) a fresh runSync fires before the cancelled IIFE bails at its next
  // isStale check (possible with sub-second SSO-cached re-login), and (c) the
  // fresh runSync returns the cancelled promise, which resolves to nothing-written.
  // The IIFE's finally guards against clobbering via the inFlightPromise===myPromise check.
  cancelSync: () => {
    console.log('[jot:sync-store] cancelSync — bumping gen, clearing inFlightPromise');
    ++currentGen;
    inFlightPromise = null;
    set({ isSyncing: false });
  },
}));

// Hydrate lastSyncAt from SecureStore. Fire-and-forget at module load — the
// store renders `null` ("never synced") until this resolves, which is the
// correct fallback semantically. Errors swallowed: failing to read the
// timestamp is non-fatal (worst case: next session shows "never synced" until
// a sync completes and writes a fresh value).
getLastSyncTime()
  .then((date) => {
    if (date !== null) {
      useSyncStore.setState({ lastSyncAt: date });
    }
  })
  .catch(() => undefined);
