import { create } from 'zustand';
import {
  CreateTimeEntryPayload,
  createBatchEntries,
  createEntry,
  deleteEntry as bqeDeleteEntry,
  deleteLocalEntry,
  fetchWeekEntries,
  insertLocalEntry,
  loadDraftSyncedEntries,
  loadEntryById,
  loadLocalWeekEntries,
  loadPendingEntries,
  markEntriesSubmissionStatus,
  markEntriesSynced,
  markEntryFailedWithError,
  markEntrySyncedWithBqeId,
  markEntryVersion,
  patchLocalEntry,
  resetEntryToPending,
  submitEntriesToWorkflow,
  updateEntry as bqeUpdateEntry,
  type WorkflowSubmitEntry,
} from '../services/bqe/timeentry';
import { toIsoDay } from '../services/bqe/utils';
import { isOnline } from '../services/sync/connectivity';
import { processQueue } from '../services/sync/queue';
import { rescheduleAllReminders } from '../services/notifications/reminders';
import { extractBqeErrorMessage } from '../services/errors';
import { applySourceTag } from '../utils/sourceTag';
import { useAuthStore } from './useAuthStore';
import { run } from '../db/database';
import type { EntrySource, LocalTimeEntry } from '../db/schema';

function inDemoMode(): boolean {
  return useAuthStore.getState().demoMode;
}

/**
 * Pull the HTTP status off an axios-shaped error, or null if the error
 * isn't an axios response (network failure, abort, generic Error). Used
 * by the batch-fallback path to tag each [jot:batch-fallback] log line
 * with the precise BQE status code.
 */
function extractHttpStatus(e: unknown): number | null {
  const ax = e as { isAxiosError?: boolean; response?: { status?: number } } | undefined;
  if (!ax?.isAxiosError) return null;
  return ax.response?.status ?? null;
}

/**
 * Compact stringifier for an axios error's response body. Mirrors the
 * `safePretty` helper in services/bqe/client.ts but without pretty-print
 * indentation — the batch-fallback log line is already verbose enough.
 * Cap at 600 chars: enough to see the BQE error envelope, short enough
 * that one failed entry doesn't dominate the buffer.
 */
function safeBody(v: unknown): string {
  if (v === undefined) return '<no body>';
  if (typeof v === 'string') return v.slice(0, 600);
  if (v === null) return 'null';
  try {
    const s = JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return '<unserializable>';
  }
}

async function markDemoSynced(localId: number): Promise<string> {
  const bqeId = `demo-entry-${localId}-${Date.now()}`;
  await run(
    `UPDATE LocalTimeEntry SET syncStatus = 'synced', bqeId = ?, version = '1', billStatus = 'Open' WHERE id = ?`,
    [bqeId, localId],
  );
  return bqeId;
}

interface NewEntryInput {
  projectId: string;
  activityId: string;
  resourceId: string;
  date: string;
  hours: number;
  memo: string | null;
  isBillable: boolean;
  source?: EntrySource;
}

/**
 * Per-entry failure record returned from `submitParsedBatch` in the
 * fallback path. `inputIndex` is the position in the original `inputs`
 * array — lets the review screen correlate the failure back to its
 * source row without re-deriving by id. `localId` is the SQLite row id
 * for the entry (still on disk, syncStatus='failed', with `lastError`
 * populated); the review screen passes these back as `priorLocalIds`
 * when the user taps "Retry failed" so we don't accumulate orphan
 * failed rows in SQLite on each retry pass.
 */
export interface BatchFailure {
  inputIndex: number;
  localId: number;
  error: string;
  httpError: boolean;
}

/**
 * Options for `submitParsedBatch`. `priorLocalIds`, when present, names
 * SQLite rows to delete BEFORE inserting the new attempt. The review
 * screen passes the failed-local-ids from the previous attempt here on
 * a "Retry failed" press so retries don't leave failed orphans behind.
 */
export interface SubmitParsedBatchOptions {
  priorLocalIds?: number[];
}

interface EntryState {
  weekEntries: LocalTimeEntry[];
  pendingEntries: LocalTimeEntry[];
  selectedDate: string;
  weekRange: { start: string; end: string } | null;
  currentResourceId: string | null;
  isLoading: boolean;
  isSyncing: boolean;
  lastError: string | null;

  setSelectedDate: (date: string) => void;
  loadWeek: (resourceId: string, weekStart: string, weekEnd: string) => Promise<void>;
  refreshLocal: () => Promise<void>;
  addEntry: (entry: NewEntryInput) => Promise<number>;
  submitEntry: (
    entry: NewEntryInput,
  ) => Promise<
    | { ok: true; queued: false; localId: number; bqeId: string }
    | { ok: true; queued: true; localId: number }
    // `httpError` distinguishes "BQE responded with a 4xx/5xx body" (true —
    // user-actionable; show the message) from "network/timeout, no
    // response" (false — silent queue, retry later). Either way the entry
    // is saved locally so nothing is lost.
    | { ok: false; localId: number; error: string; httpError: boolean }
  >;
  submitParsedBatch: (
    entries: NewEntryInput[],
    options?: SubmitParsedBatchOptions,
  ) => Promise<
    // All-good fast path (batch endpoint accepted, or fallback per-entry
    // POSTs all succeeded). `failures` is always [] on this branch — kept
    // in the shape for uniformity at the call site.
    | { ok: true; queued: false; count: number; failures: BatchFailure[] }
    // Offline path — entries inserted locally, nothing sent yet.
    | { ok: true; queued: true; count: number; failures: BatchFailure[] }
    // Partial success: batch rejected, fallback per-entry POSTs split.
    // At least one succeeded, at least one failed. The review screen
    // filters its on-screen list down to `failures` and surfaces the
    // per-entry `error` strings inline.
    | { ok: 'partial'; successCount: number; failures: BatchFailure[] }
    // Total failure: batch failed AND every per-entry retry also failed,
    // OR the batch error itself wasn't retriable. `error` carries the
    // first failure message; `failures` carries every per-entry detail.
    | { ok: false; count: number; error: string; httpError: boolean; failures: BatchFailure[] }
  >;
  retryEntry: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  saveEntryEdits: (
    id: number,
    patch: { hours?: number; memo?: string | null; isBillable?: boolean; date?: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  updateEntry: (
    id: number,
    patch: { hours?: number; memo?: string | null; isBillable?: boolean; date?: string },
  ) => Promise<void>;
  deleteEntry: (
    id: number,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  syncPendingEntries: () => Promise<void>;
  submitWeek: (
    resourceId: string,
    weekStart: string,
    weekEnd: string,
  ) => Promise<
    | {
        ok: true;
        count: number;
        failedCount: number;
        errors: Array<{ bqeId: string; error: string }>;
      }
    | { ok: false; count: 0; error: string }
  >;
}

export const useEntryStore = create<EntryState>((set, get) => ({
  weekEntries: [],
  pendingEntries: [],
  selectedDate: toIsoDay(new Date()),
  weekRange: null,
  currentResourceId: null,
  isLoading: false,
  isSyncing: false,
  lastError: null,

  setSelectedDate: (date) => set({ selectedDate: date }),

  loadWeek: async (resourceId, weekStart, weekEnd) => {
    set({
      isLoading: true,
      lastError: null,
      weekRange: { start: weekStart, end: weekEnd },
      currentResourceId: resourceId,
    });
    try {
      if (!inDemoMode()) {
        try {
          await fetchWeekEntries(resourceId, weekStart, weekEnd);
        } catch (e) {
          set({ lastError: e instanceof Error ? e.message : 'Failed to fetch entries' });
        }
      }
      const [weekEntries, pending] = await Promise.all([
        loadLocalWeekEntries(resourceId, weekStart, weekEnd),
        loadPendingEntries(),
      ]);
      set({ weekEntries, pendingEntries: pending, isLoading: false });
    } catch (e) {
      set({
        isLoading: false,
        lastError: e instanceof Error ? e.message : 'Failed to load week',
      });
    }
  },

  refreshLocal: async () => {
    const { weekRange, currentResourceId } = get();
    if (!weekRange || !currentResourceId) {
      const pending = await loadPendingEntries();
      set({ pendingEntries: pending });
      rescheduleAllReminders().catch(() => undefined);
      return;
    }
    const [weekEntries, pending] = await Promise.all([
      loadLocalWeekEntries(currentResourceId, weekRange.start, weekRange.end),
      loadPendingEntries(),
    ]);
    set({ weekEntries, pendingEntries: pending });
    rescheduleAllReminders().catch(() => undefined);
  },

  addEntry: async (input) => {
    const id = await insertLocalEntry({
      projectId: input.projectId,
      activityId: input.activityId,
      resourceId: input.resourceId,
      date: input.date,
      hours: input.hours,
      memo: input.memo,
      isBillable: input.isBillable,
      source: input.source ?? 'manual',
    });
    await get().refreshLocal();
    return id;
  },

  submitEntry: async (input) => {
    const localId = await insertLocalEntry({
      projectId: input.projectId,
      activityId: input.activityId,
      resourceId: input.resourceId,
      date: input.date,
      hours: input.hours,
      memo: input.memo,
      isBillable: input.isBillable,
      source: input.source ?? 'manual',
    });

    if (inDemoMode()) {
      const bqeId = await markDemoSynced(localId);
      await get().refreshLocal();
      return { ok: true as const, queued: false as const, localId, bqeId };
    }

    if (!isOnline()) {
      await get().refreshLocal();
      return { ok: true as const, queued: true as const, localId };
    }

    try {
      // Source tag goes in `description` only — memo is reserved for user
      // content per Quality Floor. See utils/sourceTag for format + rationale.
      const source = input.source ?? 'manual';
      const created = await createEntry({
        projectId: input.projectId,
        activityId: input.activityId,
        resourceId: input.resourceId,
        date: input.date,
        actualHours: input.hours,
        billable: input.isBillable,
        description: applySourceTag(input.memo ?? '', source),
        memo: input.memo ?? '',
      });
      await markEntrySyncedWithBqeId(
        localId,
        created.id,
        created.version != null ? String(created.version) : null,
        created.billStatus ?? null,
      );
      await get().refreshLocal();
      return { ok: true as const, queued: false as const, localId, bqeId: created.id };
    } catch (e) {
      await get().refreshLocal();
      // Distinguish "BQE rejected it" (httpError true → surface the message
      // to the user) from "couldn't reach BQE" (httpError false → silent
      // queue, retry on reconnect). Either way the entry is already saved
      // locally above, so nothing is lost.
      const bqeMsg = extractBqeErrorMessage(e);
      return {
        ok: false as const,
        localId,
        error: bqeMsg ?? (e instanceof Error ? e.message : 'Failed to submit entry'),
        httpError: bqeMsg !== null,
      };
    }
  },

  submitParsedBatch: async (inputs, options) => {
    if (inputs.length === 0) {
      return {
        ok: true as const,
        queued: false as const,
        count: 0,
        failures: [],
      };
    }

    // Retry-cleanup: when the review screen re-submits failed entries, it
    // passes the failed-rows' localIds so we delete them BEFORE inserting
    // the new attempt. Without this, repeated "Retry failed" presses
    // accumulate orphan failed rows in SQLite that bleed into the home
    // screen's week list as stuck "failed" entries.
    if (options?.priorLocalIds && options.priorLocalIds.length > 0) {
      for (const id of options.priorLocalIds) {
        await deleteLocalEntry(id).catch(() => undefined);
      }
    }

    const localIds: number[] = [];
    for (const input of inputs) {
      const id = await insertLocalEntry({
        projectId: input.projectId,
        activityId: input.activityId,
        resourceId: input.resourceId,
        date: input.date,
        hours: input.hours,
        memo: input.memo,
        isBillable: input.isBillable,
        source: input.source ?? 'scanned',
      });
      localIds.push(id);
    }

    if (inDemoMode()) {
      for (const id of localIds) await markDemoSynced(id);
      await get().refreshLocal();
      return {
        ok: true as const,
        queued: false as const,
        count: localIds.length,
        failures: [],
      };
    }

    if (!isOnline()) {
      await get().refreshLocal();
      return {
        ok: true as const,
        queued: true as const,
        count: localIds.length,
        failures: [],
      };
    }

    // Per-entry payload with source tag applied to `description` only.
    // The same payload array feeds BOTH the /timeentry/batch fast path
    // AND the per-entry fallback loop below — tagging once at this
    // construction site covers both. Default source 'scanned' matches
    // the local-insert default at the top of this function (review.tsx
    // always passes source: 'scanned'; default is belt-and-suspenders).
    const payloads: CreateTimeEntryPayload[] = inputs.map((p) => {
      const source = p.source ?? 'scanned';
      return {
        projectId: p.projectId,
        activityId: p.activityId,
        resourceId: p.resourceId,
        date: p.date,
        actualHours: p.hours,
        billable: p.isBillable,
        description: applySourceTag(p.memo ?? '', source),
        memo: p.memo ?? '',
      };
    });

    // Fast path: try the batch endpoint. BQE's /timeentry/batch is
    // all-or-nothing — one bad entry rolls back the whole call and
    // returns 400 with an empty body (no detail on which entry was bad).
    // If that happens, the catch below falls back to per-entry POSTs so
    // the good entries land and the bad ones surface their own errors.
    try {
      await createBatchEntries(payloads);
      await markEntriesSynced(localIds);
      await get().refreshLocal();
      return {
        ok: true as const,
        queued: false as const,
        count: localIds.length,
        failures: [],
      };
    } catch (batchErr) {
      const batchStatus = extractHttpStatus(batchErr);
      console.warn(
        `[jot:batch-fallback] batch failed with status=${batchStatus ?? 'no-response'}, ` +
          `retrying as ${payloads.length} individual POSTs`,
      );

      // Per-entry fallback. Reuses `createEntry` so the single-entry POST
      // path is exactly the same code manual entry runs — any future
      // change there flows through automatically.
      const failures: BatchFailure[] = [];
      const successIds: number[] = [];

      for (let i = 0; i < payloads.length; i++) {
        const payload = payloads[i];
        const localId = localIds[i];
        try {
          const created = await createEntry(payload);
          await markEntrySyncedWithBqeId(
            localId,
            created.id,
            created.version != null ? String(created.version) : null,
            created.billStatus ?? null,
          );
          successIds.push(localId);
          console.log(
            `[jot:batch-fallback] entry ${i + 1}/${payloads.length} succeeded — bqeId=${created.id}`,
          );
        } catch (entryErr) {
          const status = extractHttpStatus(entryErr);
          const bqeMsg = extractBqeErrorMessage(entryErr);
          const errStr =
            bqeMsg ??
            (entryErr instanceof Error ? entryErr.message : 'Submit failed');
          // [jot:bqe-response] from client.ts already logs the full body
          // separately — duplicating the body inline here makes the
          // [jot:batch-fallback] trail self-contained (one grep yields
          // the full diagnostic story).
          const bodyStr = safeBody((entryErr as { response?: { data?: unknown } })?.response?.data);
          console.warn(
            `[jot:batch-fallback] entry ${i + 1}/${payloads.length} failed — ` +
              `status=${status ?? 'no-response'} body=${bodyStr}`,
          );
          await markEntryFailedWithError(localId, errStr);
          failures.push({
            inputIndex: i,
            localId,
            error: errStr,
            httpError: bqeMsg !== null,
          });
        }
      }

      await get().refreshLocal();

      if (failures.length === 0) {
        // Batch endpoint hated something, but every per-entry POST
        // worked. Probably a batch-endpoint quirk on BQE's side rather
        // than a real data problem with any entry. Treat as full success.
        return {
          ok: true as const,
          queued: false as const,
          count: localIds.length,
          failures: [],
        };
      }
      if (successIds.length === 0) {
        // None made it through — total failure. Surface the first
        // failure's message (they're often all the same — same
        // resourceId / week-locked issue).
        return {
          ok: false as const,
          count: localIds.length,
          error: failures[0].error,
          httpError: failures[0].httpError,
          failures,
        };
      }
      // Partial: some landed in BQE, some didn't. The review screen
      // filters its on-screen list down to `failures` and shows the
      // per-entry `error` inline; the user fixes them (e.g. picks a
      // different phase) and taps "Retry failed".
      return {
        ok: 'partial' as const,
        successCount: successIds.length,
        failures,
      };
    }
  },

  retryEntry: async (id) => {
    await resetEntryToPending(id);
    await get().refreshLocal();
    if (!isOnline()) {
      return { ok: true as const };
    }
    const result = await processQueue();
    await get().refreshLocal();
    if (result.failed > 0) {
      return { ok: false as const, error: 'Retry failed — try again later.' };
    }
    return { ok: true as const };
  },

  saveEntryEdits: async (id, patch) => {
    // Outer try/catch is pure observability — catches any runtime error
    // BEFORE the BQE call (loadEntryById, patchLocalEntry, applySourceTag,
    // payload construction) and logs it with a stack before re-throwing.
    // BQE-call errors are caught by the inner try/catch below and return
    // a structured `{ ok: false }`, so they don't reach this catch.
    try {
      console.log(
        `[jot:saveEdits] START entryId=${id} patch=${JSON.stringify(patch)}`,
      );
      const existing =
        get().weekEntries.find((e) => e.id === id) ?? (await loadEntryById(id));
      if (!existing) {
        console.log(`[jot:saveEdits] FATAL no existing entry for entryId=${id}`);
        return { ok: false as const, error: 'Entry not found' };
      }
      console.log(
        `[jot:saveEdits] existing loaded projectId=${existing.projectId} activityId=${existing.activityId} resourceId=${existing.resourceId} version=${existing.version} source=${existing.source}`,
      );
      await patchLocalEntry(id, patch);
      if (inDemoMode()) {
        await markDemoSynced(id);
        await get().refreshLocal();
        return { ok: true as const };
      }
      if (!existing.bqeId) {
        await get().refreshLocal();
        return { ok: true as const };
      }
      try {
        // Re-apply the source tag on every edit using the entry's ORIGINAL
        // source (from `existing.source`). Two important properties:
        //   - The tag survives repeated edits — applySourceTag is idempotent
        //     for the same source, so create → edit → re-edit doesn't
        //     accumulate or strip the tag.
        //   - The source itself never changes on edit. A scan entry stays
        //     '#js' forever even if the user rewrites the memo entirely.
        // Description is only included in the update body when the memo is
        // actually being patched; an undefined patch.memo leaves description
        // untouched on BQE so we don't gratuitously overwrite the field.
        const description =
          patch.memo !== undefined
            ? applySourceTag(patch.memo ?? '', existing.source)
            : undefined;
        // BQE's PUT /timeentry/{id} requires the identity fields
        // (projectId, activityId, resourceId) on every update, even when
        // they aren't changing. Without them the call returns
        // 409 RequiredFieldMissing (ErrorCode 000.020). The edit screen
        // never lets the user reassign an entry's project/activity/
        // resource, so passing the original values from `existing` is both
        // correct and stable across the edit lifecycle.
        const payload = {
          projectId: existing.projectId,
          activityId: existing.activityId,
          resourceId: existing.resourceId,
          actualHours: patch.hours,
          memo: patch.memo ?? undefined,
          description,
          billable: patch.isBillable,
          date: patch.date,
        };
        console.log(`[jot:saveEdits] payload=${JSON.stringify(payload)}`);
        console.log('[jot:saveEdits] calling bqeUpdateEntry');
        const updated = await bqeUpdateEntry(existing.bqeId, payload, existing.version);
        console.log(
          `[jot:saveEdits] update success, new version=${updated.version}`,
        );
        await markEntryVersion(
          id,
          updated.version != null ? String(updated.version) : null,
          updated.billStatus ?? null,
        );
        await get().refreshLocal();
        return { ok: true as const };
      } catch (e) {
        await get().refreshLocal();
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : 'Failed to update entry',
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? err.stack : '(no stack)';
      console.log(`[jot:saveEdits] FAILED entryId=${id}: ${msg}`);
      console.log(stack);
      throw err;
    }
  },

  updateEntry: async (id, patch) => {
    await get().saveEntryEdits(id, patch);
  },

  deleteEntry: async (id) => {
    const existing = get().weekEntries.find((e) => e.id === id) ?? (await loadEntryById(id));
    if (existing?.bqeId && !inDemoMode()) {
      try {
        await bqeDeleteEntry(existing.bqeId);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to delete entry';
        set({ lastError: message });
        return { ok: false as const, error: message };
      }
    }
    await deleteLocalEntry(id);
    await get().refreshLocal();
    return { ok: true as const };
  },

  syncPendingEntries: async () => {
    if (get().isSyncing) return;
    set({ isSyncing: true, lastError: null });
    try {
      const result = await processQueue();
      if (result.failed > 0) {
        set({ lastError: `${result.failed} entr${result.failed === 1 ? 'y' : 'ies'} failed to sync` });
      }
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : 'Failed to sync entries' });
    } finally {
      set({ isSyncing: false });
      await get().refreshLocal();
    }
  },

  submitWeek: async (resourceId, weekStart, weekEnd) => {
    console.log(
      `[jot:submit-week] submitWeek START resourceId=${resourceId} weekStart=${weekStart} weekEnd=${weekEnd}`,
    );
    const drafts = await loadDraftSyncedEntries(resourceId, weekStart, weekEnd);
    console.log(
      `[jot:submit-week] loadDraftSyncedEntries returned count=${drafts.length} drafts=${JSON.stringify(
        drafts.map((d) => ({
          id: d.id,
          bqeId: d.bqeId,
          submissionStatus: d.submissionStatus,
          syncStatus: d.syncStatus,
          version: d.version,
          hours: d.hours,
          date: d.date,
        })),
      )}`,
    );
    if (drafts.length === 0) {
      console.log('[jot:submit-week] submitWeek END count=0 (no drafts)');
      return { ok: true as const, count: 0, failedCount: 0, errors: [] };
    }

    // Build the workflow-submit payloads. Mirror updateEntry's body shape
    // by including identity + version + (conditionally) memo/description.
    // description is re-derived from memo + source via applySourceTag so
    // the source tag round-trips correctly through the PUT.
    //
    // Two hard filters: bqeId must be present (we have nothing to submit
    // without it) AND version must be non-null. Workflow PUTs without
    // version bypass BQE's OutDatedModel concurrency check — the same
    // failure mode we just fixed — and a missing version on a synced entry
    // is a sync bug we want visible, not silently bypassed. Synced
    // entries should always carry a version from persistFetchedEntries /
    // markEntryVersion; if one shows up null here, the warning logs the
    // entry id for follow-up.
    const submitPayloads: WorkflowSubmitEntry[] = [];
    const droppedNoBqeId: number[] = [];
    const droppedNoVersion: Array<{ localId: number; bqeId: string }> = [];
    for (const e of drafts) {
      if (e.bqeId === null) {
        droppedNoBqeId.push(e.id);
        continue;
      }
      if (e.version === null) {
        droppedNoVersion.push({ localId: e.id, bqeId: e.bqeId });
        console.log(
          `[jot:submit-week] WARN skipping localId=${e.id} bqeId=${e.bqeId} (missing version — sync bug)`,
        );
        continue;
      }
      submitPayloads.push({
        bqeId: e.bqeId,
        projectId: e.projectId,
        activityId: e.activityId,
        resourceId: e.resourceId,
        date: e.date,
        hours: e.hours,
        isBillable: e.isBillable,
        memo: e.memo,
        description: e.memo !== null ? applySourceTag(e.memo, e.source) : null,
        version: e.version,
      });
    }
    console.log(
      `[jot:submit-week] id extraction draftsTotal=${drafts.length} submittable=${submitPayloads.length} droppedNoBqeId=${JSON.stringify(droppedNoBqeId)} droppedNoVersion=${JSON.stringify(droppedNoVersion)}`,
    );

    if (submitPayloads.length === 0) {
      const error = 'No submittable entries (missing version data).';
      console.log(`[jot:submit-week] submitWeek FAILED error=${error}`);
      return { ok: false as const, count: 0, error };
    }

    let succeeded: string[] = [];
    let failed: Array<{ bqeId: string; error: string }> = [];
    if (!inDemoMode()) {
      const result = await submitEntriesToWorkflow(submitPayloads);
      succeeded = result.succeeded;
      failed = result.failed;
    } else {
      console.log(
        '[jot:submit-week] demo mode — skipping submitEntriesToWorkflow network call (treating all submittable as succeeded)',
      );
      succeeded = submitPayloads.map((p) => p.bqeId);
    }

    // Map succeeded bqeIds back to localIds so markEntriesSubmissionStatus
    // only touches entries that BQE actually accepted. Building a
    // bqeId → localId map up front rather than .find()-ing per success
    // keeps this O(N) instead of O(N²) on large weeks.
    const localIdByBqeId = new Map<string, number>();
    for (const d of drafts) {
      if (d.bqeId !== null) localIdByBqeId.set(d.bqeId, d.id);
    }
    const succeededLocalIds: number[] = [];
    for (const bqeId of succeeded) {
      const localId = localIdByBqeId.get(bqeId);
      if (localId !== undefined) succeededLocalIds.push(localId);
    }

    if (succeededLocalIds.length > 0) {
      await markEntriesSubmissionStatus(succeededLocalIds, 'submitted');
    }
    console.log(
      `[jot:submit-week] markEntriesSubmissionStatus wrote submitted for localIds=${JSON.stringify(succeededLocalIds)}`,
    );
    await get().refreshLocal();

    if (succeeded.length === 0) {
      // Full failure — return ok:false with the first failure message as
      // the surface error. The full list is preserved in the logs.
      const firstError = failed[0]?.error ?? 'All entries failed to submit';
      console.log(
        `[jot:submit-week] submitWeek END status=full-failure count=0 failedCount=${failed.length}`,
      );
      return { ok: false as const, count: 0, error: firstError };
    }

    console.log(
      `[jot:submit-week] submitWeek END count=${succeeded.length} failedCount=${failed.length}`,
    );
    return {
      ok: true as const,
      count: succeeded.length,
      failedCount: failed.length,
      errors: failed,
    };
  },
}));
