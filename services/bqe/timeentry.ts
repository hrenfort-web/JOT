import { bqeClient } from './client';
import { unwrapList, toBqeDate, toIsoDay } from './utils';
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
  const response = await bqeClient.get('/timeentry', {
    params: {
      where: `resourceId='${resourceId}' AND date>='${start}' AND date<='${end}'`,
      page: '1,500',
    },
  });
  const entries = unwrapList<BqeTimeEntry>(response.data);
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
  const response = await bqeClient.post('/timeentry', toApiPayload(payload));
  return response.data as BqeTimeEntry;
}

export async function createBatchEntries(payloads: CreateTimeEntryPayload[]): Promise<unknown> {
  const response = await bqeClient.post('/timeentry/batch', payloads.map(toApiPayload));
  return response.data;
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

// TODO: Verify the actual BQE Core workflow-submit endpoint when we have credentials.
// The product spec only documents that /timeentry has a `workflow` array on the response.
// The submit endpoint is most likely something like POST /timeentry/submit with an array
// of entry IDs in the body (or a per-entry POST /timeentry/{id}/submit). Until we have
// real credentials to test against, this placeholder no-ops on success — the local rows
// still flip to submissionStatus='submitted' so the UI flow is exercised end-to-end.
export async function submitEntriesToWorkflow(bqeIds: string[]): Promise<void> {
  if (bqeIds.length === 0) return;
  // Placeholder: replace with real BQE workflow submit call once endpoint is verified.
  // Example shape (unverified):
  // await bqeClient.post('/timeentry/submit', { entryIds: bqeIds });
  return;
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
