import { bqeClient, fetchAllPages } from './client';
import { toBqeDate, toIsoDay } from './utils';
import { run, getAll, upsertMany, sqliteBool } from '../../db/database';
import {
  EntrySource,
  LocalTimeEntry,
  LocalTimeEntryRow,
  entryFromRow,
} from '../../db/schema';

export interface BqeTimeEntry {
  id: string;
  projectId: string;
  activityId: string;
  resourceId: string;
  date: string;
  actualHours: number;
  billable?: boolean;
  description?: string;
  memo?: string;
  billStatus?: string | null;
  version?: string | number | null;
  workflow?: unknown;
}

export interface CreateTimeEntryPayload {
  projectId: string;
  activityId: string;
  resourceId: string;
  date: Date | string;
  actualHours: number;
  billable: boolean;
  description?: string;
  memo?: string;
}

function toApiPayload(p: CreateTimeEntryPayload) {
  return {
    projectId: p.projectId,
    activityId: p.activityId,
    resourceId: p.resourceId,
    date: toBqeDate(p.date),
    actualHours: p.actualHours,
    billable: p.billable,
    description: p.description ?? '',
    memo: p.memo ?? '',
  };
}

export async function fetchWeekEntries(
  resourceId: string,
  weekStart: Date | string,
  weekEnd: Date | string,
): Promise<BqeTimeEntry[]> {
  const start = toIsoDay(weekStart);
  const end = toIsoDay(weekEnd);
  const entries = await fetchAllPages<BqeTimeEntry>('/timeentry', {
    where: `resourceId='${resourceId}' AND date>='${start}' AND date<='${end}'`,
  });
  await persistFetchedEntries(entries);
  return entries;
}

async function persistFetchedEntries(entries: BqeTimeEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const now = new Date().toISOString();
  const rows = entries.map((e) => [
    e.id,
    e.projectId,
    e.activityId,
    e.resourceId,
    toIsoDay(e.date),
    Number(e.actualHours ?? 0),
    e.memo ?? e.description ?? null,
    sqliteBool(e.billable ?? true),
    'synced',
    'manual' as EntrySource,
    now,
    e.billStatus ?? null,
    e.version != null ? String(e.version) : null,
  ]);
  await upsertMany(
    'LocalTimeEntry',
    [
      'bqeId',
      'projectId',
      'activityId',
      'resourceId',
      'date',
      'hours',
      'memo',
      'isBillable',
      'syncStatus',
      'source',
      'createdAt',
      'billStatus',
      'version',
    ],
    rows,
    'bqeId',
    'persistFetchedEntries',
  );
}

const LOCKED_BILL_STATUSES = new Set(['billed', 'invoiced', 'locked', 'paid']);

export function isEntryLocked(entry: { billStatus: string | null }): boolean {
  if (!entry.billStatus) return false;
  return LOCKED_BILL_STATUSES.has(entry.billStatus.toLowerCase());
}

export type LockReason = 'billed' | 'submitted' | 'approved';

export function getEntryLockReason(entry: {
  billStatus: string | null;
  submissionStatus: string | null;
}): LockReason | null {
  if (isEntryLocked(entry)) return 'billed';
  if (entry.submissionStatus === 'approved') return 'approved';
  if (entry.submissionStatus === 'submitted') return 'submitted';
  return null;
}

export function lockReasonMessage(reason: LockReason): string {
  switch (reason) {
    case 'billed':
      return 'This entry is locked because it has been billed';
    case 'submitted':
      return "This entry was submitted — it's locked while your PM reviews it";
    case 'approved':
      return 'This entry has been approved and can no longer be edited';
  }
}

export function isEntryEditable(entry: {
  billStatus: string | null;
  submissionStatus: string | null;
}): boolean {
  return getEntryLockReason(entry) === null;
}

export async function createEntry(payload: CreateTimeEntryPayload): Promise<BqeTimeEntry> {
  if (__DEV__) logCreatePayload(payload);
  // Always-on timing log so we can correlate first-save vs warm-save latency
  // from the Debug → View Logs screen on TestFlight builds. Both success
  // and failure paths log so we capture timeouts and 4xx/5xx durations too.
  const start = Date.now();
  try {
    const response = await bqeClient.post('/timeentry', toApiPayload(payload));
    const ms = Date.now() - start;
    console.log(`[jot:timeentry] POST succeeded in ${ms}ms`);
    if (__DEV__) {
      const created = response.data as { id?: string; workflow?: unknown };
      console.log('[jot:timeentry] created → id =', created?.id);
    }
    return response.data as BqeTimeEntry;
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[jot:timeentry] POST failed after ${ms}ms: ${message}`);
    throw err;
  }
}

export async function createBatchEntries(payloads: CreateTimeEntryPayload[]): Promise<unknown> {
  if (__DEV__) {
    console.log(`[jot:timeentry] batch POST × ${payloads.length}`);
    for (const p of payloads) logCreatePayload(p);
  }
  const start = Date.now();
  try {
    const response = await bqeClient.post('/timeentry/batch', payloads.map(toApiPayload));
    const ms = Date.now() - start;
    console.log(`[jot:timeentry] batch POST × ${payloads.length} succeeded in ${ms}ms`);
    return response.data;
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[jot:timeentry] batch POST × ${payloads.length} failed after ${ms}ms: ${message}`,
    );
    throw err;
  }
}

// Lazy-import the project store so timeentry.ts doesn't pull it at module
// load time (avoids initialization-order risk through the bqeClient cycle).
function logCreatePayload(p: CreateTimeEntryPayload): void {
  const body = toApiPayload(p);
  console.log('[jot:timeentry] -> POST /timeentry');
  console.log('[jot:timeentry]    body =', JSON.stringify(body));

  // Look up the projectId in the local cache to confirm it's a phase-level
  // (child) project as BQE expects, not a parent. If BQE rejects with
  // "Project Assignment does not allow this operation", the most common cause
  // is sending a parent projectId on a project that has phase children.
  // Lazy require keeps this file's module graph clean.
  let projectStore: { getState(): { flatProjects: { id: string; name: string; isPhase: boolean; parentId: string | null }[] } } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    projectStore = require('../../store/useProjectStore').useProjectStore;
  } catch {
    projectStore = null;
  }
  const flat = projectStore?.getState().flatProjects ?? [];
  const project = flat.find((x) => x.id === p.projectId);
  if (!project) {
    console.log(
      '[jot:timeentry]    projectId NOT in local cache — may be a stale phase id from a different sync',
      p.projectId,
    );
  } else {
    const childPhases = flat.filter((x) => x.isPhase && x.parentId === project.id);
    console.log('[jot:timeentry]    project =', {
      id: project.id,
      name: project.name,
      isPhase: project.isPhase,
      parentId: project.parentId,
      childPhaseCount: childPhases.length,
    });
    if (!project.isPhase && childPhases.length > 0) {
      console.log(
        `[jot:timeentry]    WARN: this projectId is a PARENT with ${childPhases.length} phase children. BQE expects the child phaseId for time entries, not the parent.`,
      );
    }
  }
}

export async function updateEntry(
  bqeId: string,
  patch: Partial<CreateTimeEntryPayload>,
  version?: string | null,
): Promise<BqeTimeEntry> {
  const body: Record<string, unknown> = {};
  if (patch.projectId !== undefined) body.projectId = patch.projectId;
  if (patch.activityId !== undefined) body.activityId = patch.activityId;
  if (patch.resourceId !== undefined) body.resourceId = patch.resourceId;
  if (patch.date !== undefined) body.date = toBqeDate(patch.date);
  if (patch.actualHours !== undefined) body.actualHours = patch.actualHours;
  if (patch.billable !== undefined) body.billable = patch.billable;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.memo !== undefined) body.memo = patch.memo;
  if (version) body.version = version;
  const response = await bqeClient.put(`/timeentry/${bqeId}`, body);
  return response.data as BqeTimeEntry;
}

export async function deleteEntry(bqeId: string): Promise<void> {
  await bqeClient.delete(`/timeentry/${bqeId}`);
}

export async function loadLocalWeekEntries(
  resourceId: string,
  weekStart: Date | string,
  weekEnd: Date | string,
): Promise<LocalTimeEntry[]> {
  const start = toIsoDay(weekStart);
  const end = toIsoDay(weekEnd);
  const rows = await getAll<LocalTimeEntryRow>(
    `SELECT * FROM LocalTimeEntry
     WHERE resourceId = ? AND date >= ? AND date <= ?
     ORDER BY date ASC, id ASC`,
    [resourceId, start, end],
  );
  return rows.map(entryFromRow);
}

export async function loadEntryById(id: number): Promise<LocalTimeEntry | null> {
  const rows = await getAll<LocalTimeEntryRow>(
    'SELECT * FROM LocalTimeEntry WHERE id = ?',
    [id],
  );
  if (rows.length === 0) return null;
  return entryFromRow(rows[0]);
}

export async function loadPendingEntries(): Promise<LocalTimeEntry[]> {
  const rows = await getAll<LocalTimeEntryRow>(
    `SELECT * FROM LocalTimeEntry WHERE syncStatus = 'pending' ORDER BY id ASC`,
  );
  return rows.map(entryFromRow);
}

export async function insertLocalEntry(input: {
  projectId: string;
  activityId: string;
  resourceId: string;
  date: string;
  hours: number;
  memo: string | null;
  isBillable: boolean;
  source: EntrySource;
}): Promise<number> {
  const result = await run(
    `INSERT INTO LocalTimeEntry
     (bqeId, projectId, activityId, resourceId, date, hours, memo, isBillable, syncStatus, source, createdAt, submissionStatus)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'draft')`,
    [
      input.projectId,
      input.activityId,
      input.resourceId,
      toIsoDay(input.date),
      input.hours,
      input.memo,
      sqliteBool(input.isBillable),
      input.source,
      new Date().toISOString(),
    ],
  );
  return result.lastInsertRowId as number;
}

export type SubmissionStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export async function markEntriesSubmissionStatus(
  ids: number[],
  status: SubmissionStatus,
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await run(
    `UPDATE LocalTimeEntry SET submissionStatus = ? WHERE id IN (${placeholders})`,
    [status, ...ids],
  );
}

/**
 * Load every local entry for a resource within an ISO-day range. Used by
 * the home-screen picker sort, which needs ~90 days of entries to rank
 * projects by recency.
 *
 * Returns the same hydrated entries as `loadLocalWeekEntries` (just over a
 * wider window). Order isn't guaranteed; callers should sort.
 */
export async function loadLocalEntriesInRange(
  resourceId: string,
  start: Date | string,
  end: Date | string,
): Promise<LocalTimeEntry[]> {
  const startIso = toIsoDay(start);
  const endIso = toIsoDay(end);
  const rows = await getAll<LocalTimeEntryRow>(
    `SELECT * FROM LocalTimeEntry
     WHERE resourceId = ? AND date >= ? AND date <= ?`,
    [resourceId, startIso, endIso],
  );
  return rows.map(entryFromRow);
}

export async function loadProjectIdsInRange(
  resourceId: string,
  start: Date | string,
  end: Date | string,
): Promise<string[]> {
  const startIso = toIsoDay(start);
  const endIso = toIsoDay(end);
  const rows = await getAll<{ projectId: string }>(
    `SELECT DISTINCT projectId FROM LocalTimeEntry
     WHERE resourceId = ? AND date >= ? AND date <= ?`,
    [resourceId, startIso, endIso],
  );
  return rows.map((r) => r.projectId);
}

/**
 * For each requested project/phase id, return the most recent entry date
 * (ISO day) recorded by `resourceId` since `sinceDate`. Phases with no entries
 * in the window are simply absent from the returned map. Used by the phase
 * picker to bubble recently-used phases to the top.
 */
export async function loadLastUsedDateByPhase(
  resourceId: string,
  phaseIds: string[],
  sinceDate: Date | string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (phaseIds.length === 0) return map;
  const since = toIsoDay(sinceDate);
  const placeholders = phaseIds.map(() => '?').join(',');
  const rows = await getAll<{ projectId: string; lastUsed: string }>(
    `SELECT projectId, MAX(date) AS lastUsed
     FROM LocalTimeEntry
     WHERE resourceId = ?
       AND date >= ?
       AND projectId IN (${placeholders})
     GROUP BY projectId`,
    [resourceId, since, ...phaseIds],
  );
  for (const r of rows) {
    if (r.lastUsed) map.set(r.projectId, r.lastUsed);
  }
  return map;
}

export async function loadDraftSyncedEntries(
  resourceId: string,
  weekStart: Date | string,
  weekEnd: Date | string,
): Promise<LocalTimeEntry[]> {
  const start = toIsoDay(weekStart);
  const end = toIsoDay(weekEnd);
  const rows = await getAll<LocalTimeEntryRow>(
    `SELECT * FROM LocalTimeEntry
     WHERE resourceId = ? AND date >= ? AND date <= ?
       AND syncStatus = 'synced'
       AND (submissionStatus = 'draft' OR submissionStatus = 'rejected' OR submissionStatus IS NULL)
     ORDER BY id ASC`,
    [resourceId, start, end],
  );
  return rows.map(entryFromRow);
}

// Submit time entries to BQE's workflow (locks them for PM approval).
//
// BQE support told us to "use the nested workflow field in the timeEntry to submit"
// (https://api-explorer.bqecore.com/docs/api/apis/timeentry). The /timeentry response
// schema documents `workflow` as an array of objects with fields { action, type,
// submitTo, submitToId, sendTo, sendToId, memo, token, version, ... } but the docs
// do NOT specify the exact body shape for "submit." The implementation below sends
// the simplest reasonable shape — PUT /timeentry/{id} with a single workflow object
// using `action: 'Submit'`. If BQE requires `submitToId` (the PM employee), `type`,
// or a different verb, the response body in our [jot:bqe] error logs will show the
// rejection reason and we iterate.
//
// TODO: Confirm exact body shape with BQE support (CoreDeveloper@bqe.com) once we
// have a sandbox test entry.
export async function submitEntriesToWorkflow(bqeIds: string[]): Promise<void> {
  if (bqeIds.length === 0) return;
  for (const id of bqeIds) {
    await bqeClient.put(`/timeentry/${id}`, {
      workflow: [{ action: 'Submit' }],
    });
  }
}

export async function patchLocalEntry(
  id: number,
  patch: { hours?: number; memo?: string | null; isBillable?: boolean; date?: string },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.hours !== undefined) {
    sets.push('hours = ?');
    params.push(patch.hours);
  }
  if (patch.memo !== undefined) {
    sets.push('memo = ?');
    params.push(patch.memo);
  }
  if (patch.isBillable !== undefined) {
    sets.push('isBillable = ?');
    params.push(sqliteBool(patch.isBillable));
  }
  if (patch.date !== undefined) {
    sets.push('date = ?');
    params.push(toIsoDay(patch.date));
  }
  if (sets.length === 0) return;
  sets.push("syncStatus = 'pending'");
  params.push(id);
  await run(`UPDATE LocalTimeEntry SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function deleteLocalEntry(id: number): Promise<void> {
  await run('DELETE FROM LocalTimeEntry WHERE id = ?', [id]);
}

export async function markEntrySyncedWithBqeId(
  localId: number,
  bqeId: string,
  version?: string | null,
  billStatus?: string | null,
): Promise<void> {
  await run(
    `UPDATE LocalTimeEntry
     SET syncStatus = 'synced',
         bqeId = ?,
         version = ?,
         billStatus = ?,
         retryCount = 0,
         lastError = NULL
     WHERE id = ?`,
    [bqeId, version ?? null, billStatus ?? null, localId],
  );
}

export async function markEntryRetryError(
  localId: number,
  retryCount: number,
  errorMessage: string,
): Promise<void> {
  await run(
    `UPDATE LocalTimeEntry
     SET syncStatus = 'pending', retryCount = ?, lastError = ?
     WHERE id = ?`,
    [retryCount, errorMessage.slice(0, 500), localId],
  );
}

export async function markEntryFailedWithError(
  localId: number,
  errorMessage: string,
): Promise<void> {
  await run(
    `UPDATE LocalTimeEntry
     SET syncStatus = 'failed', lastError = ?
     WHERE id = ?`,
    [errorMessage.slice(0, 500), localId],
  );
}

export async function resetEntryToPending(localId: number): Promise<void> {
  await run(
    `UPDATE LocalTimeEntry
     SET syncStatus = 'pending', retryCount = 0, lastError = NULL
     WHERE id = ?`,
    [localId],
  );
}

export async function markEntryVersion(
  localId: number,
  version: string | null,
  billStatus?: string | null,
): Promise<void> {
  await run(
    `UPDATE LocalTimeEntry
     SET syncStatus = 'synced', version = ?, billStatus = COALESCE(?, billStatus)
     WHERE id = ?`,
    [version, billStatus ?? null, localId],
  );
}

export async function markEntriesSynced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await run(
    `UPDATE LocalTimeEntry SET syncStatus = 'synced' WHERE id IN (${placeholders})`,
    ids,
  );
}

export async function markEntriesFailed(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await run(
    `UPDATE LocalTimeEntry SET syncStatus = 'failed' WHERE id IN (${placeholders})`,
    ids,
  );
}
