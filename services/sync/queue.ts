import { AxiosError } from 'axios';
import { getAll } from '../../db/database';
import { EntrySource, LocalTimeEntryRow } from '../../db/schema';
import {
  createEntry,
  markEntryFailedWithError,
  markEntryRetryError,
  markEntrySyncedWithBqeId,
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
        // Source tag goes in `description` (memo stays user content only).
        // The row's source survives offline → online transition because
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
