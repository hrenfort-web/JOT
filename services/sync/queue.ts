// Sync queue: drains LocalTimeEntry rows that still owe a write to the
// server. Backend-agnostic apart from the services/bqe helpers it calls.
//
// Row state machine (syncStatus, plus the createUncertain flag):
//
//   pending ──claim──▶ in_flight ──create 2xx──▶ synced
//                          │
//                          ├──create 4xx (rejected)──▶ failed
//                          │
//                          └──timeout / no response / 5xx / 408 / 429──▶ pending (createUncertain=1)
//
//   in_flight at launch ──getDb (db/database.ts, on first open)──▶ pending (createUncertain=1)
//   pending | in_flight (createUncertain=1) ──any week fetch adopts a matching server entry──▶ synced
//   failed ──user taps Retry──▶ pending
//   synced ──user edits──▶ pending (bqeId kept; drained by the PUT branch)
//
// Who may make each transition:
//   pending → in_flight: only claimEntryForCreate, a single UPDATE guarded
//     by "syncStatus='pending' AND bqeId IS NULL". submitEntry, the scan
//     fallback loop and processQueue all call it; exactly one of them wins
//     a given row and only the winner sends the POST.
//   in_flight → synced: the claim owner after a 2xx, through
//     markEntrySyncedWithBqeId (which also clears createUncertain and
//     absorbs any copy a concurrent week fetch inserted for the same id).
//   pending | in_flight (uncertain) → synced by adoption: ONLY
//     persistFetchedEntries in services/bqe/timeentry.ts, on any week fetch,
//     using the single matcher isAdoptableMatch (services/sync/adoption.ts).
//     The queue does not adopt itself; it triggers a one-day fetch for the
//     row and then re-reads the row.
//   in_flight → failed: the claim owner, only when classifyWriteFailure says
//     'rejected' (server answered 4xx other than 401/403/408/429). lastError
//     holds the server's reason and the UI shows it.
//   in_flight → pending(uncertain): the claim owner when classifyWriteFailure
//     says 'uncertain', or getDb at process start for rows a killed process
//     left behind (it runs before any consumer can query the table).
//   failed → pending: the user, via retryEntry → resetEntryToPending.
//   synced → pending: the user, via patchLocalEntry. Such rows keep their
//     bqeId and are drained by the PUT branch below, never claimed.
//
// Rules this file enforces:
//   - A row with createUncertain=1 is never POSTed until a week fetch for
//     that resource and day has run (fetchWeekEntries, single day). The
//     fetch path itself reconciles: persistFetchedEntries adopts a matching
//     server entry into the local row. Reconciliation is therefore not a
//     queue-only step — every week load (home screen, day rollover, pull to
//     refresh) performs it, so no ordering of fetch vs drain can duplicate.
//   - No response at all (offline, timeout) stops the current pass without
//     touching retryCount — being offline is not a failure.
//   - 5xx/408/429 count against MAX_RETRIES (row stays uncertain); 429 also
//     pauses the queue for Retry-After. After MAX_RETRIES the row is marked
//     failed with the last message; a later user Retry re-enters as
//     pending+uncertain, so reconciliation still runs first.

import { AxiosError } from 'axios';
import { getAll } from '../../db/database';
import { EntrySource, LocalTimeEntryRow } from '../../db/schema';
import {
  claimEntryForCreate,
  createEntry,
  fetchEntryExists,
  fetchWeekEntries,
  loadEntryById,
  markEntryCreateUncertain,
  markEntryFailedWithError,
  markEntryRetryError,
  markEntrySyncedWithBqeId,
  markEntryVersion,
  updateEntry,
} from '../bqe/timeentry';
import { classifyWriteFailure, extractBqeErrorMessage } from '../errors';
import { isOnline } from './connectivity';
import { applySourceTag } from '../../utils/sourceTag';
import { useAuthStore } from '../../store/useAuthStore';

const MAX_RETRIES = 3;
const PAUSE_FALLBACK_SECONDS = 30;

let processing = false;
let pausedUntil = 0;
let listeners: Array<() => void> = [];

export interface QueueResult {
  attempted: number;
  submitted: number;
  failed: number;
  paused: boolean;
}

export function addQueueChangeListener(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function notifyChange(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // ignore listener errors
    }
  }
}

export function isQueuePaused(): boolean {
  return Date.now() < pausedUntil;
}

// BQE returns 409 with an OutDatedModel error envelope when a PUT's version
// is stale (the entry changed server-side since our last sync). Verified
// against the live tenant 2026-07-07: {"ErrorCode":"000.017","Key":
// "OutDatedModel",...}. Retrying with the same stale version can never
// succeed, so the queue fails those immediately instead of burning the
// retry budget.
function isVersionConflict(e: unknown): boolean {
  const resp = (e as AxiosError).response;
  if (!resp || resp.status !== 409) return false;
  try {
    const body =
      typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? '');
    return /outdatedmodel/i.test(body);
  } catch {
    return false;
  }
}

// "Deleted remotely" detection for a failed update PUT. Live-tenant
// behavior (verified 2026-07-07 via bqe-test probes): a PUT to a deleted
// entry does NOT return 404 — BQE throws 500 GeneralException ("Object
// reference not set to an instance of an object"). So: an explicit 404 is
// trusted directly (defensive, in case BQE fixes their API), and for 5xx
// we confirm with a follow-up GET — which returns 204 No Content (not
// 404) when the entry is gone. An unconfirmable probe returns false so
// the error stays on the transient retry path.
async function isDeletedRemotely(e: unknown, bqeId: string): Promise<boolean> {
  const status = (e as AxiosError).response?.status;
  if (status === 404) return true;
  if (status == null || status < 500) return false;
  try {
    return !(await fetchEntryExists(bqeId));
  } catch {
    return false;
  }
}

export function pausedUntilMs(): number {
  return pausedUntil;
}

// Pause the queue for the server's Retry-After (or a fallback). Called from
// both drain branches on a 429; the caller then stops the pass.
function pauseForRateLimit(e: unknown): void {
  const headers = (e as AxiosError).response?.headers as Record<string, string> | undefined;
  const retryAfter = Number(headers?.['retry-after'] ?? PAUSE_FALLBACK_SECONDS);
  pausedUntil = Date.now() + Math.max(1, retryAfter) * 1000;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Sync failed';
}

// Outcome of draining one row. 'retry' = transient, row stays pending;
// 'skipped' = nothing to do this pass; 'pause' / 'stop' end the pass.
type DrainOutcome = 'submitted' | 'failed' | 'retry' | 'skipped' | 'pause' | 'stop';

/**
 * Create branch: rows that have never been synced (bqeId IS NULL).
 */
async function drainCreate(row: LocalTimeEntryRow): Promise<DrainOutcome> {
  const claimed = await claimEntryForCreate(row.id);
  if (!claimed) {
    console.log(`[jot:sync] claim skip localId=${row.id} (owned elsewhere)`);
    return 'skipped';
  }
  console.log(`[jot:sync] claim ok localId=${row.id}`);

  if (row.createUncertain) {
    // A previous create's outcome is unknown. Run a single-day week fetch
    // for this row's resource and date; persistFetchedEntries adopts a
    // matching server entry into this row (it is in_flight + uncertain, so
    // it qualifies). Then re-read the row to see whether that happened.
    try {
      await fetchWeekEntries(row.resourceId, row.date, row.date);
    } catch (e) {
      // The reconcile fetch failed. Release the claim, keep the row
      // pending+uncertain with its previous lastError, and stop this pass —
      // nothing was sent, so nothing else changes.
      await markEntryCreateUncertain(row.id, row.lastError ?? 'Reconcile read failed');
      console.log(`[jot:sync] uncertain localId=${row.id} reason=reconcile-read-failed (${errorMessage(e)})`);
      return 'stop';
    }
    const current = await loadEntryById(row.id);
    if (current && current.syncStatus === 'synced') {
      // Adopted on fetch (already logged as [jot:sync] adopt-on-fetch).
      return 'submitted';
    }
  }

  try {
    // Source tag goes in `description` (memo stays user content only). The
    // row's source survives offline → online transition because
    // insertLocalEntry persisted it, so a manual entry created in airplane
    // mode lands in BQE with #jm when the queue drains.
    const created = await createEntry({
      projectId: row.projectId,
      activityId: row.activityId,
      resourceId: row.resourceId,
      date: row.date,
      actualHours: row.hours,
      billable: !!row.isBillable,
      memo: row.memo ?? '',
      description: applySourceTag(row.memo ?? '', row.source as EntrySource),
    });
    await markEntrySyncedWithBqeId(
      row.id,
      created.id,
      created.version != null ? String(created.version) : null,
      created.billStatus ?? null,
    );
    console.log(`[jot:sync] post ok localId=${row.id} bqeId=${created.id}`);
    return 'submitted';
  } catch (e) {
    const message = errorMessage(e);
    if (classifyWriteFailure(e) === 'rejected') {
      const reason = extractBqeErrorMessage(e) ?? message;
      await markEntryFailedWithError(row.id, reason);
      console.log(`[jot:sync] rejected localId=${row.id} message=${reason}`);
      return 'failed';
    }

    const status = (e as AxiosError).response?.status;
    if (status == null) {
      // Offline / timeout / abort: nothing more will succeed this pass and
      // this is not a failure of the row. Don't touch retryCount.
      await markEntryCreateUncertain(row.id, message);
      console.log(`[jot:sync] uncertain localId=${row.id} reason=no-response`);
      return 'stop';
    }

    // 5xx / 408 / 429: the server answered but the write may have applied.
    const nextRetry = (row.retryCount ?? 0) + 1;
    let outcome: DrainOutcome;
    if (nextRetry >= MAX_RETRIES) {
      await markEntryFailedWithError(row.id, message);
      console.log(`[jot:sync] uncertain localId=${row.id} reason=http-${status}; retries exhausted, marked failed`);
      outcome = 'failed';
    } else {
      await markEntryRetryError(row.id, nextRetry, message, true);
      console.log(`[jot:sync] uncertain localId=${row.id} reason=http-${status} retry=${nextRetry}`);
      outcome = 'retry';
    }
    if (status === 429) {
      pauseForRateLimit(e);
      return 'pause';
    }
    return outcome;
  }
}

/**
 * Update branch: rows that already have a bqeId and were edited locally.
 * patchLocalEntry flips every edit to 'pending' while keeping the bqeId
 * (the offline / failed-PUT path in saveEntryEdits leaves the row in
 * exactly this state). The queue must UPDATE the existing server entry —
 * POSTing here created a duplicate new entry in BQE (audit SB-1). Body
 * shape mirrors saveEntryEdits' PUT: identity fields are required by BQE
 * on every update (else 409 RequiredFieldMissing), and version drives the
 * OutDatedModel concurrency check.
 */
async function drainUpdate(row: LocalTimeEntryRow, bqeId: string): Promise<DrainOutcome> {
  try {
    const updated = await updateEntry(
      bqeId,
      {
        projectId: row.projectId,
        activityId: row.activityId,
        resourceId: row.resourceId,
        date: row.date,
        actualHours: row.hours,
        billable: !!row.isBillable,
        memo: row.memo ?? '',
        description: applySourceTag(row.memo ?? '', row.source as EntrySource),
      },
      row.version,
    );
    // markEntryVersion marks synced WITHOUT touching bqeId — the row keeps
    // its identity; only version/billStatus advance.
    await markEntryVersion(
      row.id,
      updated.version != null ? String(updated.version) : null,
      updated.billStatus ?? null,
    );
    console.log(`[jot:sync] put ok localId=${row.id} bqeId=${bqeId}`);
    return 'submitted';
  } catch (e) {
    const status = (e as AxiosError).response?.status;
    if (status === 429) {
      pauseForRateLimit(e);
      return 'pause';
    }
    if (await isDeletedRemotely(e, bqeId)) {
      // The BQE entry was deleted remotely (PM/admin cleanup in BQE)
      // while this edit sat in the queue. Deliberately NOT falling
      // back to POST: silently re-creating would resurrect an entry
      // someone intentionally deleted server-side. Fail visibly so
      // the user sees the edit didn't land and can re-log the time
      // if it's genuinely still owed.
      await markEntryFailedWithError(
        row.id,
        'This entry was deleted in BQE, so your edit could not be applied. Re-enter it if the time is still owed.',
      );
      return 'failed';
    }
    if (isVersionConflict(e)) {
      // Guard against the benign race with a direct saveEntryEdits
      // PUT: if that PUT already landed (and advanced the version)
      // while this drain was in flight, the row is 'synced' by now —
      // the edit IS on the server and this conflict is just the
      // queue's stale copy losing the race. Skip without failing.
      const current = await loadEntryById(row.id);
      if (current && current.syncStatus === 'synced') {
        return 'skipped';
      }
      // Real conflict: the entry changed in BQE since our last sync.
      // Retrying with the same stale version can never succeed —
      // fail immediately instead of burning the retry budget. The
      // next week fetch reconciles the row to the server copy.
      await markEntryFailedWithError(
        row.id,
        'This entry changed in BQE since your edit, so the edit was not applied. Review the entry and edit it again.',
      );
      return 'failed';
    }
    const message = errorMessage(e);
    if (classifyWriteFailure(e) === 'rejected') {
      // Any other definite 4xx: the server read the edit and declined it.
      const reason = extractBqeErrorMessage(e) ?? message;
      await markEntryFailedWithError(row.id, reason);
      console.log(`[jot:sync] rejected localId=${row.id} message=${reason}`);
      return 'failed';
    }
    const nextRetry = (row.retryCount ?? 0) + 1;
    if (nextRetry >= MAX_RETRIES) {
      await markEntryFailedWithError(row.id, message);
      return 'failed';
    }
    await markEntryRetryError(row.id, nextRetry, message);
    return 'retry';
  }
}

export async function processQueue(): Promise<QueueResult> {
  if (useAuthStore.getState().demoMode) {
    return { attempted: 0, submitted: 0, failed: 0, paused: false };
  }
  if (processing || !isOnline() || isQueuePaused()) {
    return { attempted: 0, submitted: 0, failed: 0, paused: isQueuePaused() };
  }

  processing = true;
  let submitted = 0;
  let failed = 0;
  let paused = false;
  let attempted = 0;

  try {
    const pending = await getAll<LocalTimeEntryRow>(
      `SELECT * FROM LocalTimeEntry WHERE syncStatus = 'pending' ORDER BY id ASC`,
    );

    for (const row of pending) {
      attempted += 1;
      const outcome = row.bqeId
        ? await drainUpdate(row, row.bqeId)
        : await drainCreate(row);
      if (outcome === 'submitted') submitted += 1;
      else if (outcome === 'failed') failed += 1;
      else if (outcome === 'pause') {
        paused = true;
        break;
      } else if (outcome === 'stop') {
        break;
      }
      // 'retry' and 'skipped' fall through to the next row.
    }
  } finally {
    processing = false;
  }

  if (submitted > 0 || failed > 0 || paused) {
    notifyChange();
  }
  return { attempted, submitted, failed, paused };
}
