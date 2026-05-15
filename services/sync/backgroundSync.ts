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

import type { AxiosError } from 'axios';
import {
  fetchProjectActivityGroups,
  saveProjectActivityGroups,
  uniqueGroupIdsFromBindings,
  type ProjectActivityGroupBinding,
} from '../bqe/projectActivities';
import { fetchAndSaveGroupDetails } from '../bqe/group';
import { getAll } from '../../db/database';
import {
  readFirmSetting,
  writeFirmSetting,
  FIRM_SETTING_KEYS,
} from '../firmSettings';

// Rate-limit-aware pacing. BQE's documented per-user limit is 100 req/min.
// With concurrency 1 + 1.5s inter-batch delay, we run at ~40 req/min worst
// case (a few hundred ms per request + the delay). The aggressive 5-way
// concurrency we used before was pushing ~600 req/min on a fast network —
// well over the limit, which is why sweeps were 429-ing and starving the
// user-facing /timeentry POSTs.
//
// Sweep takes longer (~10 min for 338 projects vs. ~2 min before), but it's
// invisible background work; user-facing POST latency is what we're
// protecting. The Retry-After respect is the safety net for cases where
// the limit changes or another client is competing for the same window.
const BATCH_SIZE = 1;
const INTER_BATCH_DELAY_MS = 1500;
const SKIP_IF_SYNCED_WITHIN_MS = 24 * 60 * 60 * 1000; // 24h
const PROGRESS_CHECKPOINT_INTERVAL = 10; // write every 10 batches
const DEFAULT_RETRY_AFTER_SECONDS = 60;

let running = false;

export async function syncAllActivityGroupsInBackground(
  isStale?: () => boolean,
): Promise<void> {
  if (running) {
    console.warn('[jot:sync-bg] already running, skipping duplicate kickoff');
    return;
  }
  if (isStale?.()) {
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
      if (isStale?.()) break;
      const batch = projectIds.slice(i, i + BATCH_SIZE);
      const batchStart = Date.now();
      // BATCH_SIZE is currently 1 so `batch` always has one project.
      // The loop is still written generally so future tuning can bump
      // batch size if BQE's limits relax.
      const projectId = batch[0];
      console.log(
        `[jot:sync-bg] batch ${batchIndex}/${totalBatches} start (${batch.length} project${batch.length === 1 ? '' : 's'}: ${projectId.slice(0, 8)}…)`,
      );

      let bindings: ProjectActivityGroupBinding[] | null = null;
      try {
        bindings = await fetchProjectActivityGroups(projectId);
      } catch (e) {
        const ax = e as AxiosError | undefined;
        const status = ax?.response?.status;
        if (status === 429) {
          // Rate-limit hit. The client.ts interceptor already did one
          // Retry-After retry per request, so this is the second hit —
          // back off at the sweep level instead of retrying immediately.
          // Parse Retry-After ourselves (header name is case-insensitive
          // per RFC) and pause the WHOLE sweep, not just this batch, so
          // we don't burn the next 429 budget on the next item.
          // Axios's response.headers is a union with optional values; cast
          // to a plain string map here because at runtime everything is a
          // string. parseRetryAfterSeconds tolerates missing keys.
          const retryAfter = parseRetryAfterSeconds(
            ax?.response?.headers as Record<string, string> | undefined,
            DEFAULT_RETRY_AFTER_SECONDS,
          );
          console.warn(
            `[jot:sync-bg] batch ${batchIndex}/${totalBatches} hit 429 — pausing sweep ${retryAfter}s before continuing`,
          );
          await sleep(retryAfter * 1000);
          // Don't advance batchIndex / i — retry the same project after
          // the pause. The single-flight `running` flag keeps this from
          // overlapping with another sweep kickoff.
          continue;
        }
        const message = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error && e.stack ? e.stack : '(no stack)';
        console.warn(
          `[jot:sync-bg] batch ${batchIndex}/${totalBatches} fetch FAILED (${Date.now() - batchStart}ms): ${message}\n` +
            `  projectId: ${projectId}\n` +
            `  stack:\n${stack}`,
        );
        // Continue to the next batch after the inter-batch delay — this
        // project will be retried on a future sweep (lastSynced still
        // stale).
      }

      if (bindings !== null) {
        if (isStale?.()) break;
        try {
          await saveProjectActivityGroups(bindings, isStale);
          for (const g of uniqueGroupIdsFromBindings(bindings)) allGroupIds.add(g);
          console.log(
            `[jot:sync-bg] batch ${batchIndex}/${totalBatches} end (success, ${Date.now() - batchStart}ms, ${bindings.length} bindings)`,
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const stack = e instanceof Error && e.stack ? e.stack : '(no stack)';
          console.warn(
            `[jot:sync-bg] batch ${batchIndex}/${totalBatches} save FAILED (${Date.now() - batchStart}ms): ${message}\n` +
              `  projectId: ${projectId}\n` +
              `  stack:\n${stack}`,
          );
        }
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
      if (isStale?.()) return;
      try {
        await fetchAndSaveGroupDetails(Array.from(allGroupIds), isStale);
      } catch (e) {
        console.warn(
          '[jot:sync-bg] group/detail follow-up FAILED:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (isStale?.()) return;

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

/**
 * Parse RFC 9110 Retry-After header. Returns seconds. Falls back to
 * `defaultSeconds` if the header is missing, present-but-non-numeric, or
 * a date-form value we don't understand (we don't expect BQE to use the
 * HTTP-date variant; treat it as unparseable and back off conservatively).
 *
 * Headers are case-insensitive; axios normalises to lowercase but we
 * look up both casings just in case.
 */
function parseRetryAfterSeconds(
  headers: Record<string, string> | undefined,
  defaultSeconds: number,
): number {
  if (!headers) return defaultSeconds;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return defaultSeconds;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return defaultSeconds;
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
