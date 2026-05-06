import { create } from 'zustand';
import {
  CreateTimeEntryPayload,
  createBatchEntries,
  createEntry,
  deleteEntry as bqeDeleteEntry,
  deleteLocalEntry,
  fetchWeekEntries,
  insertLocalEntry,
  loadEntryById,
  loadLocalWeekEntries,
  loadPendingEntries,
  markEntriesFailed,
  markEntriesSynced,
  markEntrySyncedWithBqeId,
  markEntryVersion,
  patchLocalEntry,
  resetEntryToPending,
  updateEntry as bqeUpdateEntry,
} from '../services/bqe/timeentry';
import { toIsoDay } from '../services/bqe/utils';
import { isOnline } from '../services/sync/connectivity';
import { processQueue } from '../services/sync/queue';
import { rescheduleAllReminders } from '../services/notifications/reminders';
import type { EntrySource, LocalTimeEntry } from '../db/schema';

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

interface EntryState {
  weekEntries: LocalTimeEntry[];
  pendingEntries: LocalTimeEntry[];
  selectedDate: string;
  weekRange: { start: string; end: string } | null;
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
    | { ok: false; localId: number; error: string }
  >;
  submitParsedBatch: (
    entries: NewEntryInput[],
  ) => Promise<
    | { ok: true; queued: false; count: number }
    | { ok: true; queued: true; count: number }
    | { ok: false; count: number; error: string }
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
}

export const useEntryStore = create<EntryState>((set, get) => ({
  weekEntries: [],
  pendingEntries: [],
  selectedDate: toIsoDay(new Date()),
  weekRange: null,
  isLoading: false,
  isSyncing: false,
  lastError: null,

  setSelectedDate: (date) => set({ selectedDate: date }),

  loadWeek: async (resourceId, weekStart, weekEnd) => {
    set({ isLoading: true, lastError: null, weekRange: { start: weekStart, end: weekEnd } });
    try {
      try {
        await fetchWeekEntries(resourceId, weekStart, weekEnd);
      } catch (e) {
        set({ lastError: e instanceof Error ? e.message : 'Failed to fetch entries' });
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
    const { weekRange } = get();
    if (!weekRange) {
      const pending = await loadPendingEntries();
      set({ pendingEntries: pending });
      rescheduleAllReminders().catch(() => undefined);
      return;
    }
    const resourceId = get().weekEntries[0]?.resourceId;
    const [weekEntries, pending] = await Promise.all([
      resourceId
        ? loadLocalWeekEntries(resourceId, weekRange.start, weekRange.end)
        : Promise.resolve(get().weekEntries),
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

    if (!isOnline()) {
      await get().refreshLocal();
      return { ok: true as const, queued: true as const, localId };
    }

    try {
      const created = await createEntry({
        projectId: input.projectId,
        activityId: input.activityId,
        resourceId: input.resourceId,
        date: input.date,
        actualHours: input.hours,
        billable: input.isBillable,
        description: input.memo ?? '',
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
      return {
        ok: false as const,
        localId,
        error: e instanceof Error ? e.message : 'Failed to submit entry',
      };
    }
  },

  submitParsedBatch: async (inputs) => {
    if (inputs.length === 0) {
      return { ok: true as const, queued: false as const, count: 0 };
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

    if (!isOnline()) {
      await get().refreshLocal();
      return { ok: true as const, queued: true as const, count: localIds.length };
    }

    const payloads: CreateTimeEntryPayload[] = inputs.map((p) => ({
      projectId: p.projectId,
      activityId: p.activityId,
      resourceId: p.resourceId,
      date: p.date,
      actualHours: p.hours,
      billable: p.isBillable,
      description: p.memo ?? '',
      memo: p.memo ?? '',
    }));

    try {
      await createBatchEntries(payloads);
      await markEntriesSynced(localIds);
      await get().refreshLocal();
      return { ok: true as const, queued: false as const, count: localIds.length };
    } catch (e) {
      await markEntriesFailed(localIds);
      await get().refreshLocal();
      return {
        ok: false as const,
        count: localIds.length,
        error: e instanceof Error ? e.message : 'Failed to submit batch',
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
    const existing = get().weekEntries.find((e) => e.id === id) ?? (await loadEntryById(id));
    if (!existing) {
      return { ok: false as const, error: 'Entry not found' };
    }
    await patchLocalEntry(id, patch);
    if (!existing.bqeId) {
      await get().refreshLocal();
      return { ok: true as const };
    }
    try {
      const updated = await bqeUpdateEntry(
        existing.bqeId,
        {
          actualHours: patch.hours,
          memo: patch.memo ?? undefined,
          description: patch.memo ?? undefined,
          billable: patch.isBillable,
          date: patch.date,
        },
        existing.version,
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
  },

  updateEntry: async (id, patch) => {
    await get().saveEntryEdits(id, patch);
  },

  deleteEntry: async (id) => {
    const existing = get().weekEntries.find((e) => e.id === id) ?? (await loadEntryById(id));
    if (existing?.bqeId) {
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
}));
