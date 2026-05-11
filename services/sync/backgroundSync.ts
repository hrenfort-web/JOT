// Background sweep that fills in /project/{id}/activities for every active
// parent project in the tenant. Kicked off (not awaited) from initialSync
// after the eager warm-up. Aims to complete in ~60-90 seconds for a 3,200-
// project tenant.
//
// Design choices:
//   - Operates only on PARENT projects (parentId IS NULL). BQE assigns
//     activity groups at the project level; phases inherit. The resolver
//     handles the phase → parent climb at read time.
//   - Skips projects that were already synced in the last 24h, so a quick
//     re-sync after a soft restart doesn't re-pound the API.
//   - Persists checkpoint progress to LocalFirmSettings keys
//       activityGroupsLastFullSync          — wall-clock ISO when complete
//       activityGroupsBackgroundProgress    — JSON { done, total } for the
//                                              Debug screen while running
//   - Single-flight: a `running` flag in module scope prevents two parallel
//     sweeps if initialSync somehow fires twice.

import {
  fetchMultipleProjectActivityGroups,
  saveProjectActivityGroups,
  uniqueGroupIdsFromBindings,
} from '../bqe/projectActivities';
import { fetchAndSaveGroupDetails } from '../bqe/group';
import { getAll } from '../../db/database';
import {
  readFirmSetting,
  writeFirmSetting,
  FIRM_SETTING_KEYS,
} from '../firmSettings';

const BATCH_SIZE = 5;
const INTER_BATCH_DELAY_MS = 100;
const SKIP_IF_SYNCED_WITHIN_MS = 24 * 60 * 60 * 1000; // 24h
const PROGRESS_CHECKPOINT_INTERVAL = 10; // write every 10 batches

let running = false;

export async function syncAllActivityGroupsInBackground(): Promise<void> {
  if (running) {
    console.warn('[jot:sync-bg] already running, skipping duplicate kickoff');
    return;
  }
  running = true;
  const start = Date.now();
  try {
    const projectIds = await collectProjectsToSync();
    if (projectIds.length === 0) {
      console.warn('[jot:sync-bg] nothing to sync — every active project is fresh');
      await writeFirmSetting(
        FIRM_SETTING_KEYS.ACTIVITY_GROUPS_LAST_FULL_SYNC,
        new Date().toISOString(),
      );
      return;
    }
    console.warn(
      `[jot:sync-bg] starting background sweep: ${projectIds.length} projects, batch ${BATCH_SIZE}, delay ${INTER_BATCH_DELAY_MS}ms`,
    );

    const allGroupIds = new Set<string>();
    let batchIndex = 0;
    const totalBatches = Math.ceil(projectIds.length / BATCH_SIZE);

    for (let i = 0; i < projectIds.length; i += BATCH_SIZE) {
      const batch = projectIds.slice(i, i + BATCH_SIZE);
      try {
        const bindings = await fetchMultipleProjectActivityGroups(batch);
        await saveProjectActivityGroups(bindings);
        for (const g of uniqueGroupIdsFromBindings(bindings)) allGroupIds.add(g);
      } catch (e) {
        // Per-batch swallow. Logging is intentionally verbose here — these
        // surface in the Debug → View Logs screen, which is the only window
        // into background work on TestFlight builds.
        console.warn(
          `[jot:sync-bg] batch ${batchIndex}/${totalBatches} FAILED:`,
          e instanceof Error ? e.message : e,
          'projectIds:',
          batch.join(','),
        );
      }
      batchIndex += 1;

      // Periodic progress checkpoint. The Debug screen reads this to render
      // "In progress: N / M".
      if (batchIndex % PROGRESS_CHECKPOINT_INTERVAL === 0) {
        await writeFirmSetting(
          FIRM_SETTING_KEYS.ACTIVITY_GROUPS_BG_PROGRESS,
          JSON.stringify({
            done: Math.min(batchIndex * BATCH_SIZE, projectIds.length),
            total: projectIds.length,
          }),
        ).catch(() => undefined);
      }

      if (i + BATCH_SIZE < projectIds.length) {
        await sleep(INTER_BATCH_DELAY_MS);
      }
    }

    // After all project bindings land, hydrate /group/detail for whatever
    // groups we discovered (deduped with whatever was already in LocalGroup
    // from the eager phase). Bounded by the unique-group set, not the
    // project set, so this is a single small fetch even on big tenants.
    if (allGroupIds.size > 0) {
      try {
        await fetchAndSaveGroupDetails(Array.from(allGroupIds));
      } catch (e) {
        console.warn(
          '[jot:sync-bg] group/detail follow-up FAILED:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    await writeFirmSetting(
      FIRM_SETTING_KEYS.ACTIVITY_GROUPS_LAST_FULL_SYNC,
      new Date().toISOString(),
    );
    // Clear in-progress marker — readers fall back to the "last full sync"
    // timestamp once this is gone.
    await writeFirmSetting(FIRM_SETTING_KEYS.ACTIVITY_GROUPS_BG_PROGRESS, null);

    console.warn(
      `[jot:sync-bg] sweep COMPLETE — ${projectIds.length} projects, ${allGroupIds.size} unique groups, ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );
  } catch (e) {
    console.warn(
      '[jot:sync-bg] sweep FAILED at top level:',
      e instanceof Error ? e.message : e,
    );
  } finally {
    running = false;
  }
}

/**
 * Active parent projects whose activity-group binding hasn't been refreshed
 * recently. Returns the project ids in insertion order from SQLite (no
 * shuffling) — by ordering the most-recently-touched LocalProject rows
 * last we'd risk re-fetching fresh data first, so we just take whatever
 * comes back.
 */
async function collectProjectsToSync(): Promise<string[]> {
  // PARENT projects only: phases inherit. `isPhase = 0` AND `parentId IS NULL`
  // covers the parent-project case (some projects have no children at all
  // but are still parents in the sense that they own their own group).
  const rows = await getAll<{ id: string; lastSynced: string | null }>(
    `SELECT p.id AS id,
            (SELECT MAX(lastSynced) FROM LocalProjectActivityGroup WHERE projectId = p.id) AS lastSynced
     FROM LocalProject AS p
     WHERE p.isActive = 1 AND p.isPhase = 0`,
  );

  const cutoff = Date.now() - SKIP_IF_SYNCED_WITHIN_MS;
  const out: string[] = [];
  for (const r of rows) {
    if (!r.lastSynced) {
      out.push(r.id);
      continue;
    }
    const t = Date.parse(r.lastSynced);
    if (!Number.isFinite(t) || t < cutoff) {
      out.push(r.id);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exported helpers for the Debug screen / resolver to query progress
// without reaching directly into LocalFirmSettings naming.
export async function getLastFullSyncTime(): Promise<Date | null> {
  const v = await readFirmSetting(FIRM_SETTING_KEYS.ACTIVITY_GROUPS_LAST_FULL_SYNC);
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

export async function getBackgroundProgress(): Promise<{ done: number; total: number } | null> {
  const v = await readFirmSetting(FIRM_SETTING_KEYS.ACTIVITY_GROUPS_BG_PROGRESS);
  if (!v) return null;
  try {
    const parsed = JSON.parse(v);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.done === 'number' &&
      typeof parsed.total === 'number'
    ) {
      return { done: parsed.done, total: parsed.total };
    }
  } catch {
    // ignore — caller falls back to lastFullSync
  }
  return null;
}
