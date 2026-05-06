import * as SecureStore from 'expo-secure-store';
import { fetchAndSaveProjects } from '../bqe/project';
import { fetchAndSaveActivities } from '../bqe/activity';
import { fetchAndSaveEmployees } from '../bqe/employee';

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
  const total = STEPS.length;
  let completed = 0;

  onProgress?.({ step: STEPS[0].label, completed, total });

  await Promise.all(
    STEPS.map(async (step) => {
      try {
        await step.run();
      } finally {
        completed += 1;
        onProgress?.({ step: step.label, completed, total });
      }
    }),
  );

  await setLastSyncTime(new Date());
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
