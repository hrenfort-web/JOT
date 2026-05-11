import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../../theme';
import { EmptyState } from '../../components/EmptyState';
import {
  EditorValue,
  ReviewEntryEditor,
} from '../../components/ReviewEntryEditor';
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { useScanStore } from '../../store/useScanStore';
import { useToastStore } from '../../store/useToastStore';
import {
  formatHours,
  getMonday,
  getSunday,
  getWeekDays,
  toIsoDay,
} from '../../utils/dateHelpers';
import { phaseMeta } from '../../utils/phaseMeta';
import type { ParsedEntry, ParsedFlag, ParsedTimesheet } from '../../services/ai/scanner';
import {
  validateEntryDate,
  validateHours,
  validateMemo,
  validateProjectAndPhase,
} from '../../utils/validation';
import { formatError, logError } from '../../services/errors';
import { resolveActivityForEntry } from '../../services/activitySelection/resolver';
import {
  buildSessionId,
  logScanSession,
  type SubmittedEntry as LogSubmittedEntry,
} from '../../services/analytics/scanCorrections';

const WEEK_TOTAL_LOW = 30;
const WEEK_TOTAL_HIGH = 50;

interface ReviewEntry {
  id: string;
  day: string;
  projectId: string | null;
  phaseProjectId: string | null;
  hours: number;
  memo: string;
  flag: ParsedFlag | null;
  source: 'parsed' | 'manual';
}

export default function ReviewScreen() {
  const router = useRouter();
  const parsed = useScanStore((s) => s.parsed);
  const clearAll = useScanStore((s) => s.clearAll);
  const flatProjects = useProjectStore((s) => s.flatProjects);
  const user = useAuthStore((s) => s.user);
  const submitParsedBatch = useEntryStore((s) => s.submitParsedBatch);
  const showToast = useToastStore((s) => s.show);

  const today = useMemo(() => new Date(), []);
  const monday = useMemo(() => getMonday(today), [today]);
  const sunday = useMemo(() => getSunday(today), [today]);
  const weekDays = useMemo(() => getWeekDays(monday, 7), [monday]);

  const projectsById = useMemo(
    () => new Map(flatProjects.map((p) => [p.id, p])),
    [flatProjects],
  );

  const [entries, setEntries] = useState<ReviewEntry[]>(() =>
    parsed ? parsedToReview(parsed, monday) : [],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingDay, setAddingDay] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Scan-correction analytics: capture an immutable snapshot of what the AI
  // produced, plus a session ID, the moment the review screen mounts. We
  // diff this against `entries` at submit time and write the deltas to the
  // ScanSession / ScanCorrection tables. Refs (not state) because we never
  // want this to trigger re-renders or be touched by user edits.
  const scanSessionIdRef = useRef<string | null>(null);
  const originalEntriesRef = useRef<ParsedEntry[] | null>(null);
  const overallAiConfidenceRef = useRef<number>(0);

  useEffect(() => {
    if (!parsed) return;
    if (scanSessionIdRef.current) return;
    scanSessionIdRef.current = buildSessionId();
    // Deep clone so user edits to `entries` can never mutate the original
    // AI output. ParsedEntry is plain JSON so structuredClone via JSON
    // round-trip is safe and fast.
    originalEntriesRef.current = JSON.parse(
      JSON.stringify(parsed.entries),
    ) as ParsedEntry[];
    overallAiConfidenceRef.current = parsed.overallConfidence;
  }, [parsed]);

  useEffect(() => {
    if (!parsed) {
      router.replace('/scan');
    }
  }, [parsed, router]);

  const totalHours = useMemo(
    () => entries.reduce((s, e) => s + e.hours, 0),
    [entries],
  );
  const daysWithEntries = useMemo(
    () => new Set(entries.map((e) => e.day)).size,
    [entries],
  );

  const visibleDays = useMemo(() => {
    const set = new Set(entries.map((e) => e.day));
    return weekDays.filter((d) => {
      const iso = toIsoDay(d);
      const day = d.getDay();
      const isWeekday = day >= 1 && day <= 5;
      return isWeekday || set.has(iso);
    });
  }, [weekDays, entries]);

  if (!parsed) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const updateEntry = (id: string, patch: Partial<ReviewEntry>) =>
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const removeEntry = (id: string) =>
    setEntries((es) => es.filter((e) => e.id !== id));

  const handleSaveEdit = (id: string, value: EditorValue) => {
    updateEntry(id, {
      projectId: value.projectId,
      phaseProjectId: value.phaseProjectId,
      hours: value.hours,
      memo: value.memo,
      flag: null,
    });
    setEditingId(null);
  };

  const handleAdd = (day: string, value: EditorValue) => {
    setEntries((es) => [
      ...es,
      {
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        day,
        projectId: value.projectId,
        phaseProjectId: value.phaseProjectId,
        hours: value.hours,
        memo: value.memo,
        flag: null,
        source: 'manual',
      },
    ]);
    setAddingDay(null);
  };

  const onSubmit = async () => {
    if (!user?.id) {
      showToast('Not signed in', 'error');
      return;
    }
    const issue = entries
      .map((e) => ({ entry: e, problem: validateReviewEntry(e) }))
      .find((x) => x.problem !== null);
    if (issue) {
      showToast(issue.problem ?? 'Please review entries', 'error');
      setEditingId(issue.entry.id);
      return;
    }

    // Resolve activityId per entry. Each scanned entry can land on a
    // different project, and BQE rejects /timeentry POSTs whose activityId
    // isn't in the project's group. Resolve before the batch so a single
    // missing activity short-circuits the whole submit rather than failing
    // mid-batch and leaving partial state.
    const resolved: { activityId: string }[] = [];
    for (const e of entries) {
      const result = e.phaseProjectId
        ? resolveActivityForEntry({ projectId: e.phaseProjectId })
        : null;
      if (!result || result.activityId === null) {
        showToast(
          'No activity available for one of these projects — please sync, or contact your admin',
          'error',
        );
        return;
      }
      resolved.push({ activityId: result.activityId });
    }

    setSubmitting(true);

    // Fire-and-forget scan-correction logging. MUST run before the network
    // submit but MUST NOT be awaited — the user's submission cannot be
    // delayed or blocked by analytics. Errors inside logScanSession are
    // already swallowed; .catch(() => {}) here covers the synchronous
    // throw window between schedule and first await inside the service.
    const sessionId = scanSessionIdRef.current;
    const originalEntries = originalEntriesRef.current;
    if (sessionId && originalEntries) {
      const submittedForLog: LogSubmittedEntry[] = entries.map((e) => ({
        originalIndex: parseOriginalIndex(e.id),
        phaseProjectId: e.phaseProjectId,
        hours: e.hours,
        memo: e.memo,
      }));
      logScanSession({
        sessionId,
        originalEntries,
        submittedEntries: submittedForLog,
        overallAiConfidence: overallAiConfidenceRef.current,
        projectsById,
      }).catch(() => {
        // never surface analytics failures
      });
    }

    const result = await submitParsedBatch(
      entries.map((e, i) => ({
        projectId: e.phaseProjectId!,
        activityId: resolved[i].activityId,
        resourceId: user.id,
        date: e.day,
        hours: e.hours,
        memo: e.memo,
        isBillable: true,
        source: 'scanned',
      })),
    );
    setSubmitting(false);

    if (result.ok) {
      if (result.queued) {
        showToast(`${result.count} saved locally — will sync when online`, 'info');
      } else {
        showToast(`${result.count} entries submitted`, 'success');
      }
      clearAll();
      if (router.canDismiss?.()) {
        router.dismissAll();
      } else {
        router.replace('/');
      }
    } else {
      logError('review.submit', result.error);
      if (result.httpError) {
        // BQE explicitly rejected the batch — surface the real BQE error
        // string (e.g. ProjectControlLimitation 031.001). Don't pipe
        // through formatError because that genericises the message into
        // "BQE rejected this request" and hides the diagnostic detail.
        showToast(result.error, 'error');
      } else {
        // Network/timeout — keep the user-friendly wrapper.
        showToast(`Submit failed: ${formatError(new Error(result.error)).userMessage}`, 'error');
      }
    }
  };

  const conf = parsed.overallConfidence;
  const confColor = confidenceColor(conf);
  const totalWarn = totalHours > 0 && (totalHours < WEEK_TOTAL_LOW || totalHours > WEEK_TOTAL_HIGH);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Review & submit',
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.summary}>
          <View>
            <Text style={styles.summaryHeading}>
              {entries.length} {entries.length === 1 ? 'entry' : 'entries'} found
            </Text>
            <Text style={styles.summarySub}>Tap any row to edit before submitting.</Text>
          </View>
          <View style={[styles.confBadge, { backgroundColor: confColor + '22', borderColor: confColor }]}>
            <Text style={[styles.confText, { color: confColor }]}>
              {Math.round(conf * 100)}%
            </Text>
          </View>
        </View>

        {entries.length === 0 ? (
          <EmptyState
            icon="document-text-outline"
            title="No entries yet"
            subtitle="Add one for any day below or scan a different photo."
          />
        ) : null}

        {visibleDays.map((d) => {
          const iso = toIsoDay(d);
          const dayEntries = entries.filter((e) => e.day === iso);
          const dayHours = dayEntries.reduce((s, e) => s + e.hours, 0);
          return (
            <View key={iso} style={styles.dayGroup}>
              <View style={styles.dayHeader}>
                <Ionicons name="calendar-outline" size={16} color={colors.muted} />
                <Text style={styles.dayHeaderTitle}>
                  {d.toLocaleDateString(undefined, { weekday: 'long' })}
                </Text>
                <Text style={styles.dayHeaderDate}>
                  {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </Text>
                <View style={{ flex: 1 }} />
                {dayHours > 0 ? (
                  <Text style={styles.dayHeaderHours}>{formatHours(dayHours)}h</Text>
                ) : null}
              </View>

              <View style={styles.dayBody}>
                {dayEntries.map((entry) =>
                  editingId === entry.id ? (
                    <ReviewEntryEditor
                      key={entry.id}
                      initial={{
                        projectId: entry.projectId,
                        phaseProjectId: entry.phaseProjectId,
                        hours: entry.hours,
                        memo: entry.memo,
                      }}
                      showRemove
                      onSave={(v) => handleSaveEdit(entry.id, v)}
                      onRemove={() => {
                        removeEntry(entry.id);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <EntryDisplayRow
                      key={entry.id}
                      entry={entry}
                      projectsById={projectsById}
                      onEdit={() => setEditingId(entry.id)}
                    />
                  ),
                )}

                {addingDay === iso ? (
                  <ReviewEntryEditor
                    initial={{
                      projectId: null,
                      phaseProjectId: null,
                      hours: 0,
                      memo: '',
                    }}
                    onSave={(v) => handleAdd(iso, v)}
                    onCancel={() => setAddingDay(null)}
                  />
                ) : (
                  <Pressable
                    onPress={() => {
                      setEditingId(null);
                      setAddingDay(iso);
                    }}
                    style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
                  >
                    <Ionicons name="add" size={18} color={colors.accent} />
                    <Text style={styles.addBtnText}>Add entry</Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}

        <View style={styles.totalBar}>
          <View>
            <Text style={styles.totalLabel}>
              Week total ({daysWithEntries} of 5 days)
            </Text>
            {totalWarn ? (
              <Text style={styles.totalWarn}>
                {totalHours < WEEK_TOTAL_LOW
                  ? 'Less than usual — double-check before submitting.'
                  : 'More than 50 hours — verify before submitting.'}
              </Text>
            ) : null}
          </View>
          <Text style={styles.totalHours}>{formatHours(totalHours)}h</Text>
        </View>

        <Pressable
          onPress={onSubmit}
          disabled={submitting || entries.length === 0}
          style={({ pressed }) => [
            styles.submitBtn,
            (submitting || entries.length === 0) && styles.submitDisabled,
            pressed && !submitting && styles.pressed,
          ]}
        >
          {submitting ? (
            <>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.submitText}>Submitting {entries.length} entries…</Text>
            </>
          ) : (
            <Text style={styles.submitText}>Submit to BQE Core</Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

interface EntryDisplayRowProps {
  entry: ReviewEntry;
  projectsById: Map<string, { name: string; color: string | null; phaseCode: string | null; parentId: string | null }>;
  onEdit: () => void;
}

function EntryDisplayRow({ entry, projectsById, onEdit }: EntryDisplayRowProps) {
  const phase = entry.phaseProjectId ? projectsById.get(entry.phaseProjectId) : null;
  const parent = phase?.parentId
    ? projectsById.get(phase.parentId)
    : entry.projectId
      ? projectsById.get(entry.projectId)
      : phase;
  const meta = phaseMeta(phase?.phaseCode ?? null, phase?.name ?? null);
  const projectName = parent?.name ?? 'Unknown project';
  const color = parent?.color ?? phase?.color ?? colors.border;
  const flagged = entry.flag !== null;

  return (
    <Pressable
      onPress={onEdit}
      style={({ pressed }) => [
        styles.row,
        flagged && styles.rowFlagged,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color ?? colors.border }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTitle}>
          <Text style={styles.rowName} numberOfLines={1}>
            {projectName}
          </Text>
          {phase || entry.phaseProjectId ? (
            <Text style={styles.rowPhase}>{meta.code}</Text>
          ) : null}
        </View>
        <Text style={styles.rowMemo} numberOfLines={1}>
          {entry.memo || 'Add a memo'}
        </Text>
        {flagged ? (
          <View style={styles.flagRow}>
            <Ionicons name="warning" size={12} color="#92400E" />
            <Text style={styles.flagText}>{entry.flag?.reason}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowHours}>{formatHours(entry.hours)}h</Text>
        <Ionicons name="pencil-outline" size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
}

function validateReviewEntry(entry: ReviewEntry): string | null {
  const project = validateProjectAndPhase(entry.projectId ?? entry.phaseProjectId, entry.phaseProjectId);
  if (!project.ok) return project.message ?? 'Pick a project';
  const hours = validateHours(entry.hours);
  if (!hours.ok) return hours.message ?? 'Add hours';
  const memo = validateMemo(entry.memo);
  if (!memo.ok) return memo.message ?? 'Add a memo';
  const date = validateEntryDate(entry.day);
  if (!date.ok) return date.message ?? 'Pick a valid date';
  if (entry.flag !== null) return `Verify flagged entry: ${entry.flag.reason}`;
  return null;
}

/**
 * Recover the AI's original entry index from a ReviewEntry id. Parsed
 * entries are tagged `parsed-${i}` at mount time; user-added entries are
 * `manual-...`. Returns null for added entries so the analytics layer can
 * classify them as `added_entry`.
 */
function parseOriginalIndex(id: string): number | null {
  if (!id.startsWith('parsed-')) return null;
  const n = Number(id.slice('parsed-'.length));
  return Number.isFinite(n) ? n : null;
}

function parsedToReview(parsed: ParsedTimesheet, weekStart: Date): ReviewEntry[] {
  return parsed.entries.map((e, i) => {
    const flag = parsed.flags.find((f) => f.entryIndex === i) ?? null;
    return {
      id: `parsed-${i}`,
      day: aiDayToIso(e.day, weekStart),
      projectId: e.projectId,
      phaseProjectId: e.phaseProjectId,
      hours: e.hours,
      memo: e.memo ?? '',
      flag,
      source: 'parsed' as const,
    };
  });
}

function aiDayToIso(day: string, weekStart: Date): string {
  const lower = day.toLowerCase().trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(lower)) return lower.slice(0, 10);

  const offsets: Record<string, number> = {
    monday: 0, mon: 0,
    tuesday: 1, tue: 1, tues: 1,
    wednesday: 2, wed: 2,
    thursday: 3, thu: 3, thurs: 3,
    friday: 4, fri: 4,
    saturday: 5, sat: 5,
    sunday: 6, sun: 6,
  };
  const offset = offsets[lower] ?? 0;
  const date = new Date(weekStart);
  date.setDate(weekStart.getDate() + offset);
  return toIsoDay(date);
}

function confidenceColor(c: number): string {
  if (c > 0.9) return colors.accent;
  if (c >= 0.7) return '#F59E0B';
  return colors.danger;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 48,
    gap: 16,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.subtle,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  summaryHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  summarySub: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
  },
  confBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  confText: {
    fontSize: 13,
    fontWeight: '700',
  },
  dayGroup: {
    gap: 8,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  dayHeaderTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
  },
  dayHeaderDate: {
    fontSize: 12,
    color: colors.muted,
  },
  dayHeaderHours: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  dayBody: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  rowFlagged: {
    backgroundColor: '#FEF3C7',
    borderColor: '#F59E0B',
  },
  pressed: {
    opacity: 0.85,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    flexShrink: 1,
  },
  rowPhase: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.muted,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: colors.subtle,
  },
  rowMemo: {
    fontSize: 12,
    color: colors.muted,
  },
  flagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  flagText: {
    fontSize: 11,
    color: '#92400E',
    fontWeight: '600',
    flexShrink: 1,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowHours: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  addBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
  },
  totalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.subtle,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginTop: 8,
  },
  totalLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  totalWarn: {
    fontSize: 11,
    color: '#92400E',
    marginTop: 2,
  },
  totalHours: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 16,
    minHeight: 56,
  },
  submitDisabled: {
    backgroundColor: colors.border,
  },
  submitText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
