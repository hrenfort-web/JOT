// /project/{projectId}/activities — returns the activity groups assigned to a
// project. Each row carries the membership-record id plus the group's id
// (`itemId`) and name (`item`). itemType: 139 is the BQE constant for
// "activity group" — we store it for forward compat (other itemTypes may
// surface here in future BQE versions).
//
// This replaces the /projectassignment + LocalProject.groupId path. Studio G's
// tenant returns 0 rows from /projectassignment, but populates this endpoint
// for every project that has any activity restriction. Confirmed via the
// bqe-test discovery harness on 2026-05-11.

import { bqeClient } from './client';
import { upsertMany } from '../../db/database';

export interface BqeProjectActivityRaw {
  // Defensive loose type — BQE has historically renamed fields between
  // controller versions. The parser below handles each known variant.
  [key: string]: unknown;
}

export interface ProjectActivityGroupBinding {
  id: string;          // membership record id (LocalProjectActivityGroup.id)
  projectId: string;
  groupId: string;     // the itemId in BQE's response — points to LocalGroup.id
  groupName: string | null;
  itemType: number | null;
}

// Concurrency cap for the multi-project fetch. Dropped from 5 → 1 because
// the eager warm-up path (services/sync/initialSync.ts runActivityGroupPhase)
// was firing 5 parallel /project/{id}/activities GETs alongside any
// concurrent /timeentry traffic, which pushed past BQE's 100/min rate
// limit during cold start. The 1500ms inter-request sleep matches
// backgroundSync's pacing so both phases share one rate-limit budget.
const FETCH_CONCURRENCY = 1;
const INTER_REQUEST_DELAY_MS = 1500;

let shapeLogged = false;

export async function fetchProjectActivityGroups(
  projectId: string,
): Promise<ProjectActivityGroupBinding[]> {
  const response = await bqeClient.get(
    `/project/${encodeURIComponent(projectId)}/activities`,
  );
  const rows = extractRowsFromResponse(response.data);
  const out: ProjectActivityGroupBinding[] = [];
  for (const row of rows) {
    if (!shapeLogged) {
      logFirstShape(row);
      shapeLogged = true;
    }
    const binding = parseRow(row, projectId);
    if (binding) out.push(binding);
  }
  return out;
}

/**
 * Fetch /project/{id}/activities for many projects with bounded concurrency
 * and an inter-request delay matching backgroundSync's pacing. Errors on
 * individual projects are logged and skipped; the overall promise still
 * resolves with the successful results so a single bad project can't tank
 * a whole sync phase.
 *
 * TODO(future cleanup): the rate-limit logic here (concurrency cap +
 * inter-request sleep + per-error swallow) duplicates the pattern in
 * services/sync/backgroundSync.ts. Both paths call into the same BQE
 * endpoint with the same constraints; they should share a single
 * throttled fetcher (e.g. a per-tenant token bucket exported from
 * services/bqe/client.ts) instead of each maintaining its own pacing
 * constants. Deferred because the consolidation touches three files and
 * we want this commit narrow to the cold-relaunch hydration fix.
 */
export async function fetchMultipleProjectActivityGroups(
  projectIds: string[],
): Promise<ProjectActivityGroupBinding[]> {
  if (projectIds.length === 0) return [];
  const out: ProjectActivityGroupBinding[] = [];
  // Hand-rolled bounded-parallel runner. Avoids pulling in p-limit as a dep
  // since this is the only place we need it.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < projectIds.length) {
      const idx = cursor++;
      const pid = projectIds[idx];
      try {
        const rows = await fetchProjectActivityGroups(pid);
        // Push directly — JS is single-threaded so no synchronization needed.
        for (const r of rows) out.push(r);
      } catch (e) {
        if (__DEV__) {
          console.log(
            '[jot:project-activities] fetch FAILED for',
            pid,
            e instanceof Error ? e.message : e,
          );
        }
      }
      // Pace requests within the worker. Skip the sleep after the LAST
      // item so the function doesn't add an avoidable delay at the end.
      if (cursor < projectIds.length) {
        await sleep(INTER_REQUEST_DELAY_MS);
      }
    }
  }
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, projectIds.length) }, worker);
  await Promise.all(workers);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function saveProjectActivityGroups(
  bindings: ProjectActivityGroupBinding[],
): Promise<void> {
  if (bindings.length === 0) return;
  const now = new Date().toISOString();
  const rows = bindings.map((b) => [
    b.id,
    b.projectId,
    b.groupId,
    b.groupName,
    b.itemType,
    now,
  ]);
  await upsertMany(
    'LocalProjectActivityGroup',
    ['id', 'projectId', 'groupId', 'groupName', 'itemType', 'lastSynced'],
    rows,
    'id',
  );
}

/** Unique groupIds collected from a list of bindings — input to /group/detail. */
export function uniqueGroupIdsFromBindings(
  bindings: ProjectActivityGroupBinding[],
): string[] {
  const set = new Set<string>();
  for (const b of bindings) {
    if (b.groupId) set.add(b.groupId);
  }
  return Array.from(set);
}

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

function extractRowsFromResponse(data: unknown): BqeProjectActivityRaw[] {
  if (Array.isArray(data)) return data as BqeProjectActivityRaw[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.value)) return obj.value as BqeProjectActivityRaw[];
    if (Array.isArray(obj.data)) return obj.data as BqeProjectActivityRaw[];
    if (Array.isArray(obj.items)) return obj.items as BqeProjectActivityRaw[];
  }
  return [];
}

function logFirstShape(row: BqeProjectActivityRaw): void {
  // Logged in both dev and release for the first row of each fresh fetch
  // cycle. Verifies that BQE hasn't renamed `itemId` / `item` / `itemType`
  // out from under us on another tenant. Gate behind __DEV__ once Studio G's
  // shape is confirmed stable in production.
  console.log(
    '[jot:project-activities-shape] first row keys =',
    Object.keys(row),
  );
  try {
    console.log(
      '[jot:project-activities-shape] first row =',
      JSON.stringify(row).slice(0, 600),
    );
  } catch {
    console.log('[jot:project-activities-shape] first row = <unserializable>');
  }
}

function parseRow(
  row: BqeProjectActivityRaw,
  fallbackProjectId: string,
): ProjectActivityGroupBinding | null {
  const id = pickString(row, ['id']);
  const groupId = pickString(row, ['itemId', 'groupId']);
  if (!id || !groupId) return null;

  // BQE's /project/{id}/activities response carries projectId per row. Trust
  // that, but fall back to the path parameter when missing — the response
  // we observed always had it.
  const projectId = pickString(row, ['projectId']) ?? fallbackProjectId;

  const groupName = pickString(row, ['item', 'itemName', 'groupName']);
  const itemTypeRaw = row.itemType;
  const itemType =
    typeof itemTypeRaw === 'number'
      ? itemTypeRaw
      : typeof itemTypeRaw === 'string' && itemTypeRaw.trim().length > 0
        ? Number(itemTypeRaw)
        : null;

  return {
    id,
    projectId,
    groupId,
    groupName: groupName ?? null,
    itemType: itemType != null && Number.isFinite(itemType) ? itemType : null,
  };
}

function pickString(row: BqeProjectActivityRaw, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
