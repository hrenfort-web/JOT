import * as SecureStore from 'expo-secure-store';
import { fetchAndSaveProjects } from '../bqe/project';
import { fetchAndSaveActivities } from '../bqe/activity';
import { fetchAndSaveEmployees } from '../bqe/employee';
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';

const LAST_SYNC_KEY = 'jot_last_sync';

export interface SyncProgress {
  step: string;
  completed: number;
  total: number;
}

export type ProgressCallback = (progress: SyncProgress) => void;

interface SyncStep {
  label: string;
  run: () => Promise<number>;
}

const STEPS: SyncStep[] = [
  { label: 'Loading projects', run: fetchAndSaveProjects },
  { label: 'Loading activities', run: fetchAndSaveActivities },
  { label: 'Loading team', run: fetchAndSaveEmployees },
];

export async function runInitialSync(onProgress?: ProgressCallback): Promise<void> {
  if (useAuthStore.getState().demoMode) {
    await setLastSyncTime(new Date());
    return;
  }
  const t0 = Date.now();
  if (__DEV__) console.log('[jot:sync] runInitialSync START');

  const total = STEPS.length;
  let completed = 0;

  onProgress?.({ step: STEPS[0].label, completed, total });

  await Promise.all(
    STEPS.map(async (step) => {
      const stepStart = Date.now();
      try {
        const count = await step.run();
        if (__DEV__) {
          console.log(
            `[jot:sync] ${step.label}: ${count} rows in ${Date.now() - stepStart}ms`,
          );
        }
      } catch (e) {
        if (__DEV__) console.log(`[jot:sync] ${step.label} FAILED:`, e);
        throw e;
      } finally {
        completed += 1;
        onProgress?.({ step: step.label, completed, total });
      }
    }),
  );

  if (__DEV__) console.log(`[jot:sync] BQE fetches done in ${Date.now() - t0}ms`);

  // Pull the freshly-saved rows out of SQLite into the in-memory stores so
  // screens that subscribe (home, picker, settings) render immediately when
  // they mount. Without this, the home screen reads an empty store and shows
  // a perpetual spinner even though SQLite is populated.
  try {
    const refreshStart = Date.now();
    await useProjectStore.getState().refresh();
    if (__DEV__) {
      console.log(
        `[jot:sync] useProjectStore.refresh in ${Date.now() - refreshStart}ms — flat=${
          useProjectStore.getState().flatProjects.length
        }`,
      );
    }
  } catch (e) {
    if (__DEV__) console.log('[jot:sync] project store refresh FAILED:', e);
  }

  try {
    const refreshStart = Date.now();
    await useEntryStore.getState().refreshLocal();
    if (__DEV__) {
      console.log(
        `[jot:sync] useEntryStore.refreshLocal in ${Date.now() - refreshStart}ms`,
      );
    }
  } catch (e) {
    if (__DEV__) console.log('[jot:sync] entry store refresh FAILED:', e);
  }

  await setLastSyncTime(new Date());
  if (__DEV__) console.log(`[jot:sync] runInitialSync COMPLETE in ${Date.now() - t0}ms`);
}

export async function getLastSyncTime(): Promise<Date | null> {
  const raw = await SecureStore.getItemAsync(LAST_SYNC_KEY);
  return raw ? new Date(raw) : null;
}

export async function setLastSyncTime(date: Date): Promise<void> {
  await SecureStore.setItemAsync(LAST_SYNC_KEY, date.toISOString());
}

export async function clearLastSyncTime(): Promise<void> {
  await SecureStore.deleteItemAsync(LAST_SYNC_KEY);
}
