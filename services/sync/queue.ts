import { AxiosError } from 'axios';
import { getAll } from '../../db/database';
import { EntrySource, LocalTimeEntryRow } from '../../db/schema';
import {
  createEntry,
  fetchEntryExists,
  loadEntryById,
  markEntryFailedWithError,
  markEntryRetryError,
  markEntrySyncedWithBqeId,
  markEntryVersion,
  updateEntry,
} from '../bqe/timeentry';
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
      try {
        if (row.bqeId) {
          // Edited previously-synced entry. patchLocalEntry flips every
          // edit to 'pending' while keeping the bqeId (the offline /
          // failed-PUT path in saveEntryEdits leaves the row in exactly
          // this state). The queue must UPDATE the existing BQE entry —
          // POSTing here created a duplicate new entry in BQE (audit
          // SB-1). Body shape mirrors saveEntryEdits' PUT: identity
          // fields are required by BQE on every update (else 409
          // RequiredFieldMissing), and version drives the OutDatedModel
          // concurrency check.
          const updated = await updateEntry(
            row.bqeId,
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
          // markEntryVersion marks synced WITHOUT touching bqeId — the
          // row keeps its identity; only version/billStatus advance.
          await markEntryVersion(
            row.id,
            updated.version != null ? String(updated.version) : null,
            updated.billStatus ?? null,
          );
        } else {
          // Never-synced entry — create it. Source tag goes in
          // `description` (memo stays user content only). The row's
          // source survives offline → online transition because
          // insertLocalEntry persisted it, so a manual entry created in
          // airplane mode lands in BQE with #jm when the queue drains.
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
        }
        submitted += 1;
      } catch (e) {
        const status = (e as AxiosError).response?.status;
        if (status === 429) {
          const headers = (e as AxiosError).response?.headers as Record<string, string> | undefined;
          const retryAfter = Number(headers?.['retry-after'] ?? PAUSE_FALLBACK_SECONDS);
          pausedUntil = Date.now() + Math.max(1, retryAfter) * 1000;
          paused = true;
          break;
        }
        if (row.bqeId && (await isDeletedRemotely(e, row.bqeId))) {
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
          failed += 1;
          continue;
        }
        if (row.bqeId && isVersionConflict(e)) {
          // Guard against the benign race with a direct saveEntryEdits
          // PUT: if that PUT already landed (and advanced the version)
          // while this drain was in flight, the row is 'synced' by now —
          // the edit IS on the server and this conflict is just the
          // queue's stale copy losing the race. Skip without failing.
          const current = await loadEntryById(row.id);
          if (current && current.syncStatus === 'synced') {
            continue;
          }
          // Real conflict: the entry changed in BQE since our last sync.
          // Retrying with the same stale version can never succeed —
          // fail immediately instead of burning the retry budget. The
          // next week fetch reconciles the row to the server copy.
          await markEntryFailedWithError(
            row.id,
            'This entry changed in BQE since your edit, so the edit was not applied. Review the entry and edit it again.',
          );
          failed += 1;
          continue;
        }
        const message = e instanceof Error ? e.message : 'Sync failed';
        const nextRetry = (row.retryCount ?? 0) + 1;
        if (nextRetry >= MAX_RETRIES) {
          await markEntryFailedWithError(row.id, message);
          failed += 1;
        } else {
          await markEntryRetryError(row.id, nextRetry, message);
        }
      }
    }
  } finally {
    processing = false;
  }

  if (submitted > 0 || failed > 0 || paused) {
    notifyChange();
  }
  return { attempted, submitted, failed, paused };
}
