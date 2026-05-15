import * as SecureStore from 'expo-secure-store';
import { fetchAndSaveProjects } from '../bqe/project';
import { fetchAndSaveActivities } from '../bqe/activity';
import { fetchAndSaveEmployees } from '../bqe/employee';
import { fetchAndSaveGroupDetails } from '../bqe/group';
import {
  fetchMultipleProjectActivityGroups,
  saveProjectActivityGroups,
  uniqueGroupIdsFromBindings,
} from '../bqe/projectActivities';
import { fetchAllPages } from '../bqe/client';
import { syncAllActivityGroupsInBackground } from './backgroundSync';
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { toIsoDay } from '../bqe/utils';

const LAST_SYNC_KEY = 'jot_last_sync';

export interface SyncProgress {
  step: string;
  completed: number;
  total: number;
}

export type ProgressCallback = (progress: SyncProgress) => void;

interface SyncStep {
  label: string;
  run: (isStale?: () => boolean) => Promise<number>;
}

const STEPS: SyncStep[] = [
  { label: 'Loading projects', run: fetchAndSaveProjects },
  { label: 'Loading activities', run: fetchAndSaveActivities },
  { label: 'Loading team', run: fetchAndSaveEmployees },
];

export async function runInitialSync(
  onProgress?: ProgressCallback,
  isStale?: () => boolean,
): Promise<void> {
  if (useAuthStore.getState().demoMode) {
    // No-op short-circuit for demo mode — there's nothing to fetch from
    // BQE when the store is seeded locally. Persistence of lastSyncAt is
    // owned by useSyncStore.runSync's IIFE finally, which runs after this
    // returns and writes the timestamp (gated by isStale, so a logout
    // mid-sync correctly suppresses the bump).
    return;
  }
  if (isStale?.()) return;
  const t0 = Date.now();
  if (__DEV__) console.log('[jot:sync] runInitialSync START');

  const total = STEPS.length;
  let completed = 0;

  onProgress?.({ step: STEPS[0].label, completed, total });

  // STEPS run sequentially to avoid SQLite "cannot start a transaction
  // within a transaction" errors. Each step ends in an upsertMany() that
  // opens its own withTransactionAsync; running three in parallel on the
  // single expo-sqlite connection occasionally caught a 2nd transaction
  // mid-flight and threw. The cost is ~1-2s extra wall-clock time vs the
  // prior Promise.all — acceptable for a once-per-launch sync, and the
  // bottleneck is BQE pagination not the SQLite writes.
  for (const step of STEPS) {
    const stepStart = Date.now();
    try {
      const count = await step.run(isStale);
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
  }

  if (__DEV__) console.log(`[jot:sync] BQE fetches done in ${Date.now() - t0}ms`);

  if (isStale?.()) return;

  // Note: the legacy /projectassignment + LocalProject.groupId sync was
  // removed. Studio G's tenant doesn't populate /projectassignment (404
  // every call), and the path was unused for activity selection — the
  // activity-group phase below uses /project/{id}/activities instead.
  // See bqe-test/investigate-overhead-pins.mjs for the original
  // discovery that confirmed the right endpoint.

  // Activity-group phase (the actual mechanism Studio G uses).
  //
  // /project/{id}/activities → which activity groups a project is bound to,
  // /group/detail            → which activities each group contains.
  //
  // Eager step: warm up the user's recently-used projects first (typically
  // <50 rows; sub-second on a real network). This guarantees the time-entry
  // screen has the data it needs the moment the user lands on it.
  //
  // Background step: kick off a non-awaited sweep of every active project
  // in the tenant. Studio G has 3,200+ projects; at 5 concurrent and ~150ms
  // per call that completes in ~90s. Failures are logged and skipped.
  if (isStale?.()) return;
  await runActivityGroupPhase(isStale);

  if (isStale?.()) return;

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

  if (isStale?.()) return;

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

  // Persistence of lastSyncAt is owned end-to-end by useSyncStore.runSync's
  // IIFE finally — it both writes setLastSyncTime and updates the in-memory
  // zustand state, gated by isStale so a logout mid-sync correctly
  // suppresses the bump. runInitialSync writes nothing here.
  if (__DEV__) console.log(`[jot:sync] runInitialSync COMPLETE in ${Date.now() - t0}ms`);
}

// -------------------------------------------------------------------------
// Activity-group sync phase
// -------------------------------------------------------------------------

const ACTIVE_PROJECT_WINDOW_DAYS = 90;

/**
 * Two-stage activity-group sync:
 *
 *  1. Eager warm-up: fetch /project/{id}/activities for every project the
 *     current user has logged time against in the last 90 days. Map phase
 *     ids to parent ids before fetching — activity groups are assigned at
 *     the project (parent) level. Then fetch /group/detail for every
 *     unique groupId surfaced.
 *
 *  2. Background full sync: kick off (don't await) a sweep of every active
 *     project in the tenant so the cache fills in even for projects the
 *     user hasn't touched yet.
 *
 * Failures inside either stage are logged (`[jot:sync] activity-group …`)
 * and swallowed — the resolver's firm-wide fallback prevents data loss
 * even when this whole phase no-ops.
 */
async function runActivityGroupPhase(isStale?: () => boolean): Promise<void> {
  console.warn('[jot:sync] activity-group phase START');
  try {
    if (isStale?.()) return;
    const eagerProjectIds = await collectRecentProjectIds();
    if (eagerProjectIds.length === 0) {
      console.warn(
        '[jot:sync] activity-group eager: no recent projects — skipping eager warm-up',
      );
    } else {
      const eagerStart = Date.now();
      const bindings = await fetchMultipleProjectActivityGroups(eagerProjectIds);
      if (isStale?.()) return;
      await saveProjectActivityGroups(bindings, isStale);
      const groupIds = uniqueGroupIdsFromBindings(bindings);
      if (groupIds.length > 0) {
        if (isStale?.()) return;
        await fetchAndSaveGroupDetails(groupIds, isStale);
      }
      console.warn(
        `[jot:sync] activity-group eager warm-up END — ${eagerProjectIds.length} projects, ${groupIds.length} groups, ${Date.now() - eagerStart}ms`,
      );
    }
  } catch (e) {
    console.warn(
      '[jot:sync] activity-group eager warm-up FAILED:',
      e instanceof Error ? e.message : e,
    );
  }

  // Background full sync — fire and forget. Errors inside the background
  // task are caught by the task itself; the .catch here is belt-and-braces
  // in case the function throws synchronously before its first await.
  syncAllActivityGroupsInBackground(isStale).catch((e) => {
    console.warn(
      '[jot:sync-bg] kickoff FAILED:',
      e instanceof Error ? e.message : e,
    );
  });
}

/**
 * Distinct PARENT project ids for the current user's last-90-day entries.
 *
 * BQE time entries reference the phase (child) projectId; activity groups
 * are assigned at the parent level, so we walk phase → parent before
 * returning. If we can't resolve a parent (e.g. an entry against a
 * standalone project), we include the original id.
 */
async function collectRecentProjectIds(): Promise<string[]> {
  const user = useAuthStore.getState().user;
  if (!user?.id) return [];
  const since = new Date();
  since.setDate(since.getDate() - ACTIVE_PROJECT_WINDOW_DAYS);

  let entryRows: Array<{ projectId?: string }>;
  try {
    entryRows = await fetchAllPages<{ projectId?: string }>('/timeentry', {
      where: `resourceId='${user.id}' AND date>='${toIsoDay(since)}'`,
      fields: 'projectId',
    });
  } catch (e) {
    console.warn(
      '[jot:sync] activity-group: failed to fetch recent entries for warm-up:',
      e instanceof Error ? e.message : e,
    );
    return [];
  }

  // Snapshot the project list once for fast parent lookups.
  const projects = useProjectStore.getState().flatProjects;
  const byId = new Map<string, { id: string; parentId: string | null }>();
  for (const p of projects) byId.set(p.id, { id: p.id, parentId: p.parentId });

  const parents = new Set<string>();
  for (const row of entryRows) {
    const phaseId = row.projectId;
    if (!phaseId) continue;
    const node = byId.get(phaseId);
    if (!node) {
      parents.add(phaseId);
      continue;
    }
    parents.add(node.parentId ?? node.id);
  }
  return Array.from(parents);
}

// -------------------------------------------------------------------------
// Last-sync timestamp persistence
// -------------------------------------------------------------------------

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
