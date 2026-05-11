// /group/detail — returns membership rows binding each group to its member
// activities. Each row is flat: { groupId, entityId, entity, id, … }. To
// get the full activity list for a group, we filter by groupId and collect
// the entityIds.
//
// Docs: https://api-explorer.bqecore.com/docs/api/apis/group#GETGroupDetailList
// Confirmed shape via bqe-test/group-detail.mjs on 2026-05-11.
//
// EARLIER VERSION OF THIS FILE was wrong: it filtered by `id='...'` (the
// membership-row primary key) and looked for nested `activities[]` arrays
// inside response objects. The actual response is a flat array of
// `{ groupId, entityId, ... }` membership rows, filtered by `groupId='...'`.

import { bqeClient } from './client';
import { upsertMany } from '../../db/database';

export interface BqeGroupDetailRaw {
  [key: string]: unknown;
}

export interface GroupDetail {
  id: string;
  name: string | null;
  activityIds: string[];
}

// Batch up to 50 groups per request (50 OR clauses in a single where filter).
// BQE's query parser handles longer strings but the latency curve flattens
// above ~50 — splitting smaller wins us better parallel throughput.
const GROUP_BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 5;
const GROUP_FIELDS = 'groupId,entityId,entity,id';

let shapeLogged = false;

/**
 * Fetch every group's full activity-id list from /group/detail and reduce
 * to one GroupDetail per group. Batches with bounded concurrency to respect
 * the rate limit, and dedupes the input groupIds.
 *
 * Note: the response from /group/detail is a flat array of membership rows
 * (one row per activity within each group), not a list of group objects.
 * We aggregate client-side.
 */
export async function fetchGroupDetails(
  groupIds: string[],
): Promise<GroupDetail[]> {
  const uniqueIds = Array.from(new Set(groupIds.filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  shapeLogged = false;

  // Group activityIds by groupId as we accumulate rows across batches.
  const byGroup = new Map<string, { activityIds: Set<string> }>();

  // Build batches (chunks of GROUP_BATCH_SIZE), then run them with bounded
  // concurrency via a simple work-stealing loop.
  const batches: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += GROUP_BATCH_SIZE) {
    batches.push(uniqueIds.slice(i, i + GROUP_BATCH_SIZE));
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < batches.length) {
      const idx = cursor++;
      const batch = batches[idx];
      try {
        await fetchBatchInto(batch, byGroup);
      } catch (e) {
        if (__DEV__) {
          console.log(
            '[jot:group] batch fetch FAILED, batch size',
            batch.length,
            'err:',
            e instanceof Error ? e.message : e,
          );
        }
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(BATCH_CONCURRENCY, batches.length) },
    worker,
  );
  await Promise.all(workers);

  // Names come from a separate /group lookup — /group/detail rows don't
  // carry the group name. We could fetch /group?where=id in (...) but it's
  // cheap to leave name null here and let upstream callers populate from
  // LocalProjectActivityGroup.groupName when needed.
  const out: GroupDetail[] = [];
  for (const [id, agg] of byGroup) {
    out.push({
      id,
      name: null,
      activityIds: Array.from(agg.activityIds),
    });
  }

  if (__DEV__) {
    const totalActivities = out.reduce((s, g) => s + g.activityIds.length, 0);
    console.log(
      `[jot:group] fetched ${out.length} groups, ${totalActivities} activity bindings`,
    );
  }

  return out;
}

async function fetchBatchInto(
  batchIds: string[],
  byGroup: Map<string, { activityIds: Set<string> }>,
): Promise<void> {
  // BQE's where syntax: single-quote each id, join with OR.
  const where = batchIds.map((id) => `groupId='${id}'`).join(' OR ');
  // Page size needs to comfortably exceed the worst-case rows-per-batch.
  // Studio G's "Overhead" group has ~22 activities; assume up to ~50 per
  // group → 50 groups × 50 ≈ 2500. Cap at 1000 (BQE's documented max).
  const response = await bqeClient.get('/group/detail', {
    params: {
      where,
      fields: GROUP_FIELDS,
      page: '1,1000',
    },
  });
  const rows = extractRowsFromResponse(response.data);
  for (const row of rows) {
    if (!shapeLogged) {
      logFirstShape(row);
      shapeLogged = true;
    }
    const groupId = pickString(row, ['groupId']);
    const entityId = pickString(row, ['entityId']);
    if (!groupId || !entityId) continue;
    let agg = byGroup.get(groupId);
    if (!agg) {
      agg = { activityIds: new Set<string>() };
      byGroup.set(groupId, agg);
    }
    agg.activityIds.add(entityId);
  }
}

function extractRowsFromResponse(data: unknown): BqeGroupDetailRaw[] {
  if (Array.isArray(data)) return data as BqeGroupDetailRaw[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.value)) return obj.value as BqeGroupDetailRaw[];
    if (Array.isArray(obj.data)) return obj.data as BqeGroupDetailRaw[];
    if (Array.isArray(obj.items)) return obj.items as BqeGroupDetailRaw[];
  }
  return [];
}

function logFirstShape(row: BqeGroupDetailRaw): void {
  console.log('[jot:group-shape] first row keys =', Object.keys(row));
  try {
    console.log(
      '[jot:group-shape] first row =',
      JSON.stringify(row).slice(0, 600),
    );
  } catch {
    console.log('[jot:group-shape] first row = <unserializable>');
  }
}

function pickString(row: BqeGroupDetailRaw, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export async function saveGroupDetails(groups: GroupDetail[]): Promise<void> {
  if (groups.length === 0) return;
  const now = new Date().toISOString();
  const rows = groups.map((g) => [
    g.id,
    g.name,
    JSON.stringify(g.activityIds),
    now,
  ]);
  await upsertMany(
    'LocalGroup',
    ['id', 'name', 'activityIds', 'lastSynced'],
    rows,
    'id',
  );
}

export async function fetchAndSaveGroupDetails(
  groupIds: string[],
): Promise<number> {
  const groups = await fetchGroupDetails(groupIds);
  await saveGroupDetails(groups);
  return groups.length;
}
