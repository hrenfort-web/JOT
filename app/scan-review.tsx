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

import { colors } from '../theme';
import { EmptyState } from '../components/EmptyState';
import {
  EditorValue,
  ReviewEntryEditor,
} from '../components/ReviewEntryEditor';
import { useAuthStore } from '../store/useAuthStore';
import { useProjectStore } from '../store/useProjectStore';
import { useEntryStore } from '../store/useEntryStore';
import { useScanStore, type ReviewEntry } from '../store/useScanStore';
import { useToastStore } from '../store/useToastStore';
import {
  formatHours,
  getMonday,
  getSunday,
  getWeekDays,
  toIsoDay,
} from '../utils/dateHelpers';
import { phaseMeta } from '../utils/phaseMeta';
import type { ParsedEntry, ParsedTimesheet } from '../services/ai/scanner';
import {
  validateEntryDate,
  validateHours,
  validateMemo,
  validateProjectAndPhase,
} from '../utils/validation';
import { formatError, logError } from '../services/errors';
import { resolveActivityForEntry } from '../services/activitySelection/resolver';
import {
  buildSessionId,
  logScanSession,
  type SubmittedEntry as LogSubmittedEntry,
} from '../services/analytics/scanCorrections';

const WEEK_TOTAL_LOW = 30;
const WEEK_TOTAL_HIGH = 50;

// Custom back button rendered via Stack.Screen's headerLeft. Replaces the
// native back chevron because iOS 26 native-stack drops usePreventRemove
// hook subscriptions after the first Alert dismiss cycle — Phase 3c device
// verification confirmed the callback simply stops firing on the second
// back tap, with no way to recover from inside the hook. Owning the back
// affordance ourselves sidesteps every native-stack edge case in one move.
function CustomBackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ fontSize: 28, color: colors.accent, marginRight: 4, lineHeight: 28 }}>
        ‹
      </Text>
      <Text style={{ fontSize: 17, color: colors.accent, fontWeight: '500' }}>Back</Text>
    </Pressable>
  );
}

export default function ReviewScreen() {
  const router = useRouter();
  const parsed = useScanStore((s) => s.parsed);
  const clearAll = useScanStore((s) => s.clearAll);
  const setReviewEntries = useScanStore((s) => s.setReviewEntries);
  // Submit-driven nav must pass through the beforeRemove listener silently
  // — we don't want a "Discard scan?" prompt on top of a "Submitted" toast.
  // Flipped to true right before the success branch dispatches navigation,
  // never reset (the screen is unmounting anyway).
  const hasSubmittedRef = useRef(false);
  // Set true at the start of every dismissReview() call so the cascade
  // safety effect below (router.replace('/scan') on !parsed) doesn't fire
  // when WE are the reason parsed went null. The cascade still serves its
  // intended purpose — bouncing the user to the Scan tab when they reach
  // /scan-review without a parsed scan (deep link, dev hot-reload) — but
  // it must not race our own dismiss-to-home when submit/Discard runs
  // clearAll() and then dispatches navigation.
  const isDismissingRef = useRef(false);
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

  // Draft-restore on mount: if the user previously edited the review list
  // and navigated away, useScanStore.reviewEntries holds their edits. Re-
  // hydrate from there; fall back to the AI's fresh parsedToReview output
  // for a brand-new scan. Evaluated once via lazy useState — no
  // subscription, so subsequent store updates from this same component's
  // write effect don't loop back as state churn.
  const [entries, setEntries] = useState<ReviewEntry[]>(() => {
    const storedDraft = useScanStore.getState().reviewEntries;
    if (storedDraft && storedDraft.length > 0) return storedDraft;
    return parsed ? parsedToReview(parsed, monday) : [];
  });

  // Draft-write effect: persist every edit back to the scan store so a
  // navigation-away-and-back restores the user's in-progress corrections
  // rather than reverting to the AI's first guess. Cheap per-edit write
  // (in-memory zustand set; no DB round-trip). clearAll() on submit
  // success nulls this slot, so the next scan starts clean.
  useEffect(() => {
    setReviewEntries(entries);
  }, [entries, setReviewEntries]);

  // Discard-confirmation overlay. State-controlled JSX (rendered at the
  // bottom of the screen body) instead of Alert.alert + usePreventRemove,
  // which broke on iOS 26 native-stack: the hook subscription dropped
  // after the first Alert dismiss cycle so subsequent back taps couldn't
  // be intercepted. Owning both the back affordance (CustomBackButton)
  // and the modal (in-app overlay) removes every native-stack edge case
  // from the path.
  const [discardOverlayVisible, setDiscardOverlayVisible] = useState(false);

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

  // Cascade safety: if the user lands on /scan-review without a parsed
  // scan in the store (deep link, dev hot-reload that wiped state),
  // bounce them to the Scan tab so they can capture a fresh image. Guard
  // on isDismissingRef so this effect doesn't fire when WE just ran
  // clearAll() as part of an intentional dismiss — that path races the
  // dismiss-to-home and the user ends up on Scan capture instead of home.
  useEffect(() => {
    if (!parsed && !isDismissingRef.current) {
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

  // Stack pop helper — same pattern HeaderHomeButton uses for the entry
  // flow. Works reliably here now because the Phase 3i rename
  // (scan/processing → scan-processing, scan/review → scan-review)
  // removed the URL-prefix collision with the /scan tab. Before the
  // rename, dismissAll from /scan/review popped back to /scan (the Scan
  // tab) rather than past (tabs) to /, because expo-router treats
  // /scan/* as descendants of the /scan route. With the new flat URLs
  // (/scan-processing, /scan-review), neither shares a prefix with
  // /scan, so dismissAll pops cleanly through to (tabs) and replace('/')
  // resolves to the home tab as the (tabs) index. Used by
  // handleBackPress (empty-entries + submit-bypass branches) and the
  // discard overlay's Discard button. The submit-success path uses the
  // same pattern inline.
  const dismissReview = () => {
    // Mark intent BEFORE any router call so the cascade safety effect
    // sees the flag on its next render-tick read and bails. Order is
    // load-bearing: clearing parsed (in the Discard path) re-renders
    // the screen, which fires the cascade effect, which would race
    // the dismiss if isDismissingRef weren't already true.
    isDismissingRef.current = true;
    // router.replace('/') directly — bypasses the canDismiss/dismissAll
    // pair we had through Phase 3i/3j because dismissAll preserves the
    // last-active tab in the (tabs) navigator. The user started this
    // flow from the Scan tab, so dismissAll lands them on Scan UI even
    // when the Stack frames are cleared correctly. replace('/') targets
    // the home route directly, which forces the (tabs) navigator to
    // activate its index (home) tab.
    router.replace('/');
  };

  // Custom back handler. Three branches:
  //   1. Submit-driven (hasSubmittedRef true): dismiss immediately —
  //      mirrors the cascade-pass-through that usePreventRemove used to
  //      handle for the `if (!parsed)` effect post-clearAll.
  //   2. Has entries: show the discard overlay; user picks Cancel/Discard.
  //   3. Empty entries: dismiss immediately — nothing to lose.
  const handleBackPress = () => {
    if (hasSubmittedRef.current) {
      dismissReview();
      return;
    }
    if (entries.length > 0) {
      setDiscardOverlayVisible(true);
      return;
    }
    dismissReview();
  };

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
      // Clear the previous BQE rejection — any field change means the
      // user is addressing it. The next submit attempt re-evaluates.
      submitError: null,
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
        // Manual-added entries don't carry a handwritten guess — the
        // editor's projectId resolves the name via projectsById at render
        // time. Empty here is correct.
        projectName: '',
        hours: value.hours,
        memo: value.memo,
        flag: null,
        source: 'manual',
        submitError: null,
        lastLocalId: null,
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

    // Pass any prior-attempt localIds so submitParsedBatch can clean up
    // the previous-failure SQLite rows before reinserting. On the first
    // attempt every entry's `lastLocalId` is null, so this filters down
    // to the empty array — no-op. On a "Retry failed" press, only the
    // failed rows have lastLocalId set, and those get deleted before the
    // retry attempt inserts new rows.
    const priorLocalIds = entries
      .map((e) => e.lastLocalId)
      .filter((v): v is number => v !== null);

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
      { priorLocalIds },
    );
    setSubmitting(false);

    if (result.ok === true) {
      // Full success — either everything posted, or everything was queued
      // offline. Either way the review screen is done. hasSubmittedRef is
      // set true so handleBackPress's user-tap branch can no longer fire
      // the discard overlay (race window between toast and screen
      // unmount). dismissReview() handles isDismissingRef + the actual
      // router dispatch; clearAll() runs first so the scan store is
      // cleaned before the next render.
      hasSubmittedRef.current = true;
      if (result.queued) {
        showToast(`${result.count} saved locally — will sync when online`, 'info');
      } else {
        showToast(`${result.count} entries submitted`, 'success');
      }
      clearAll();
      dismissReview();
      return;
    }

    if (result.ok === 'partial') {
      // Some landed in BQE, some didn't. Filter the on-screen list down
      // to the failed entries with their per-row error captured, so the
      // user can fix and retry. Successful entries are now real BQE rows
      // that the home screen will pick up on next sync; they don't need
      // to stay visible here.
      const failedByIndex = new Map(result.failures.map((f) => [f.inputIndex, f]));
      const remaining: ReviewEntry[] = [];
      entries.forEach((entry, i) => {
        const fail = failedByIndex.get(i);
        if (!fail) return; // succeeded — drop from review list
        remaining.push({
          ...entry,
          submitError: fail.error,
          lastLocalId: fail.localId,
        });
      });
      setEntries(remaining);
      const failedCount = result.failures.length;
      const total = result.successCount + failedCount;
      showToast(
        `${result.successCount} of ${total} submitted — ${failedCount} need attention`,
        'info',
      );
      return;
    }

    // Total failure — every per-entry POST also rejected. Annotate each
    // entry with its specific error so the user can see which is which.
    logError('review.submit', result.error);
    const failedByIndex = new Map(result.failures.map((f) => [f.inputIndex, f]));
    setEntries((es) =>
      es.map((entry, i) => {
        const fail = failedByIndex.get(i);
        if (!fail) return entry;
        return {
          ...entry,
          submitError: fail.error,
          lastLocalId: fail.localId,
        };
      }),
    );

    if (result.httpError) {
      // BQE explicitly rejected — surface the real error string (e.g.
      // ProjectControlLimitation 031.001). Don't pipe through formatError
      // because that genericises the message into "BQE rejected this
      // request" and hides the diagnostic detail.
      showToast(result.error, 'error');
    } else {
      // Network/timeout — keep the user-friendly wrapper.
      showToast(
        `Submit failed: ${formatError(new Error(result.error)).userMessage}`,
        'error',
      );
    }
  };

  const conf = parsed.overallConfidence;
  const confTone = confidenceVariant(conf);
  const totalWarn = totalHours > 0 && (totalHours < WEEK_TOTAL_LOW || totalHours > WEEK_TOTAL_HIGH);
  // When at least one entry carries a prior submitError, the next submit
  // is a retry — relabel the button so the user knows they're not
  // re-trying the whole batch.
  const hasFailedEntries = entries.some((e) => e.submitError !== null);
  const failedCount = entries.filter((e) => e.submitError !== null).length;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Review & submit',
          // Custom back affordance so the discard-confirmation gate is
          // 100% owned by our JSX — no native chevron, no Alert.alert, no
          // usePreventRemove. iOS 26 native-stack lost the preventRemove
          // hook subscription after the first Alert dismiss cycle; this
          // is the workaround.
          headerLeft: () => <CustomBackButton onPress={handleBackPress} />,
          // Disable swipe-back so there's no second uncontrolled exit
          // path that bypasses CustomBackButton.
          gestureEnabled: false,
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
          <View
            style={[
              styles.confBadge,
              { backgroundColor: confTone.background, borderColor: confTone.border },
            ]}
          >
            <Text style={[styles.confText, { color: confTone.text }]}>
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
                <Ionicons name="calendar-outline" size={16} color={colors.textTertiary} />
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
            // Switch to danger-fill when the next submit is a retry of
            // previously-failed entries. The colour difference signals
            // "this is the cleanup pass" without changing the geometry.
            hasFailedEntries && styles.submitBtnRetry,
            (submitting || entries.length === 0) && styles.submitDisabled,
            pressed &&
              !submitting &&
              entries.length > 0 &&
              (hasFailedEntries ? styles.submitBtnRetryPressed : styles.submitBtnPressed),
          ]}
        >
          {submitting ? (
            <>
              <ActivityIndicator color={colors.surface} />
              <Text style={styles.submitText}>
                {hasFailedEntries
                  ? `Retrying ${failedCount}…`
                  : `Submitting ${entries.length} entries…`}
              </Text>
            </>
          ) : (
            <Text
              style={[
                styles.submitText,
                submitting || entries.length === 0
                  ? styles.submitTextDisabled
                  : null,
              ]}
            >
              {hasFailedEntries
                ? `Retry failed (${failedCount})`
                : 'Submit'}
            </Text>
          )}
        </Pressable>
      </ScrollView>

      {/*
        Discard-confirmation overlay. Rendered last so absolute positioning
        sits above the ScrollView. Visibility is component state — no
        UIKit presentation context, no native modal lifecycle, just a
        rendered View tree that mounts/unmounts with `discardOverlayVisible`.
        See the comment above the state declaration for the iOS 26
        native-stack background.
      */}
      {discardOverlayVisible ? (
        <View style={styles.discardScrim}>
          <View style={styles.discardCard}>
            <Text style={styles.discardTitle}>Discard scan?</Text>
            <Text style={styles.discardMessage}>Your edits will be lost.</Text>
            <View style={styles.discardButtonRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                onPress={() => setDiscardOverlayVisible(false)}
                style={({ pressed }) => [
                  styles.discardButton,
                  pressed && styles.discardButtonPressed,
                ]}
              >
                <Text style={styles.discardCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Discard"
                onPress={() => {
                  useScanStore.getState().clearAll();
                  setDiscardOverlayVisible(false);
                  dismissReview();
                }}
                style={({ pressed }) => [
                  styles.discardButton,
                  styles.discardButtonDestructive,
                  pressed && styles.discardButtonPressed,
                ]}
              >
                <Text style={styles.discardDestructiveText}>Discard</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
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
  // Known-unmatched: the AI returned null for BOTH projectId AND
  // phaseProjectId — i.e. it could not find a row in the scan lookup
  // table to match the handwritten name. We surface an app-controlled
  // nudge in this case instead of the AI's free-text reason, which has
  // historically asserted "<name> doesn't exist" about real projects
  // that the user simply needs to pick from the full list.
  const isUnmatched =
    entry.projectId === null && entry.phaseProjectId === null;
  const projectName = isUnmatched
    ? 'Tap to pick the project'
    : (parent?.name ?? 'Unknown project');
  const color = parent?.color ?? phase?.color ?? colors.border;
  const flagged = entry.flag !== null;
  // submitError takes visual precedence over the AI's parse-time flag —
  // a BQE rejection is more recent and more actionable than the model's
  // "I'm unsure about this hour" hint.
  const rejected = entry.submitError !== null;
  // Always surface the warning chip for an unmatched entry, even when
  // the AI didn't attach an explicit flag — the user needs the nudge to
  // know they have to pick a project before submit. Quote the AI's
  // best guess at the handwritten name when we have one ("Couldn't
  // match \"Illumio\" — tap to pick it"); fall back to "this entry"
  // only when the AI returned no name at all (rare — usually means
  // truly illegible writing or an empty row).
  const showFlagRow = !rejected && (isUnmatched || flagged);
  const unmatchedGuess = entry.projectName.trim();
  const flagText = isUnmatched
    ? unmatchedGuess.length > 0
      ? `Couldn't match "${unmatchedGuess}" — tap to pick it.`
      : "Couldn't match this entry to one of your projects — tap to pick it."
    : entry.flag?.reason;

  return (
    <Pressable
      onPress={onEdit}
      style={({ pressed }) => [
        styles.row,
        rejected && styles.rowRejected,
        !rejected && (flagged || isUnmatched) && styles.rowFlagged,
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
        {rejected ? (
          <View style={styles.rejectedRow}>
            <Ionicons name="alert-circle" size={12} color={colors.danger} />
            <Text style={styles.rejectedText} numberOfLines={2}>
              {entry.submitError}
            </Text>
          </View>
        ) : showFlagRow ? (
          <View style={styles.flagRow}>
            <Ionicons name="warning" size={12} color={colors.accent} />
            <Text style={styles.flagText}>{flagText}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowHours}>{formatHours(entry.hours)}h</Text>
        <Ionicons name="pencil-outline" size={16} color={colors.textTertiary} />
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
      // Preserve the AI's best guess at the handwritten name even when it
      // couldn't match to a project. The review screen quotes it back in
      // the unmatched-row nudge so the user sees the specific name they
      // wrote ("Couldn't match \"Illumio\" — tap to pick it").
      projectName: e.projectName ?? '',
      hours: e.hours,
      memo: e.memo ?? '',
      flag,
      source: 'parsed' as const,
      submitError: null,
      lastLocalId: null,
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

// Confidence badge Theme B variants. Three intensities of warmth so the
// badge reads at a glance:
//   high (>0.9)        — solid accent fill, cream text. The "AI was sure."
//   medium (0.7–0.9)   — accent-tinted fill, accent text + border. "OK, verify."
//   low (<0.7)         — danger-tinted fill, danger text + border. "Please check."
// Returns the three colours the badge needs as a tuple.
function confidenceVariant(c: number): {
  background: string;
  border: string;
  text: string;
} {
  if (c > 0.9) {
    return { background: colors.accent, border: colors.accent, text: colors.surface };
  }
  if (c >= 0.7) {
    return { background: colors.accentTint, border: colors.accent, text: colors.accent };
  }
  return { background: colors.dangerTint, border: colors.danger, text: colors.danger };
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
  // Summary banner — cream surface, hairline border. Theme B convention
  // for elevated chrome that's still part of the page rhythm.
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  summaryHeading: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.text,
  },
  summarySub: {
    fontSize: 12,
    color: colors.textSecondary,
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
    fontWeight: '500',
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
    fontWeight: '500',
    color: colors.text,
  },
  dayHeaderDate: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  dayHeaderHours: {
    fontSize: 13,
    fontWeight: '500',
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  // AI-flagged row (the model is unsure about something — wording or
  // hours). Accent-muted treatment so the user is drawn to it without
  // it reading as an error. Reserved-amber treatment removed in Theme B
  // to avoid two competing warm hues on the same screen.
  rowFlagged: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
    borderWidth: 1,
  },
  // BQE-rejected row — sits on top of the AI-flagged styling. Uses the
  // danger-tint surface so it reads as "you need to fix this" rather
  // than the accent-muted treatment used for AI-flagged ambiguity.
  rowRejected: {
    backgroundColor: colors.dangerTint,
    borderColor: colors.danger,
    borderWidth: 1,
  },
  rejectedRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    marginTop: 4,
  },
  rejectedText: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '500',
    color: colors.danger,
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
    fontWeight: '500',
    color: colors.text,
    flexShrink: 1,
  },
  // Phase code chip — same accent-muted treatment as the PhasePill
  // component on home/entry, so the visual signature is consistent
  // across screens.
  rowPhase: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.accent,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: colors.accentTint,
  },
  rowMemo: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  flagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  flagText: {
    fontSize: 11,
    color: colors.accent,
    fontWeight: '500',
    flexShrink: 1,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowHours: {
    fontSize: 15,
    fontWeight: '500',
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
    fontWeight: '500',
    color: colors.accent,
  },
  // Total bar — same surface/hairline treatment as the summary banner.
  // The "Week total" value is the second-largest number on the screen
  // (after the per-day totals); keeps its visual weight via size, not
  // bold weight.
  totalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginTop: 8,
  },
  totalLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
  },
  // "Less than usual / more than 50h" hint — informational, not a
  // problem. Routes through textSecondary, not warning/danger.
  totalWarn: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
  },
  totalHours: {
    fontSize: 22,
    fontWeight: '500',
    color: colors.text,
  },
  // Submit / Retry-failed button. Pill geometry matches login + hours.
  // Default fill = accent (green-light submit). When the next submit is
  // a retry of failed entries, the fill swaps to danger so the colour
  // signals "you're cleaning up rejected entries" without changing
  // shape or position.
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.accent,
    borderRadius: 28,
    height: 56,
  },
  submitBtnPressed: {
    backgroundColor: colors.accentPressed,
  },
  submitBtnRetry: {
    backgroundColor: colors.danger,
  },
  // Pressed-state for the retry variant — darker red. Matches the
  // accentPressed convention (one step darker than the base).
  submitBtnRetryPressed: {
    backgroundColor: '#7E2D22',
  },
  submitDisabled: {
    backgroundColor: colors.disabledBg,
  },
  submitText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '500',
  },
  submitTextDisabled: {
    color: colors.disabledText,
  },
  // ── Discard-confirmation overlay ──────────────────────────────────
  // In-app modal substitute for Alert.alert. Uses the screen's own JSX
  // tree so iOS native presentation context can't interfere with
  // dismiss / re-show cycles (the failure mode usePreventRemove + Alert
  // hit in Phase 3c on iOS 26 native-stack).
  discardScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    zIndex: 1000,
    elevation: 1000,
  },
  // Cream card matches Theme B surface convention used elsewhere on the
  // page (summary, total bar). Drop shadow lifts it above the scrim.
  discardCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 24,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  discardTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  discardMessage: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 20,
  },
  discardButtonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  discardButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discardButtonDestructive: {
    backgroundColor: colors.accent,
  },
  discardButtonPressed: {
    opacity: 0.7,
  },
  discardCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  // White-on-accent pair already used by the submit button above; same
  // colors.surface token for visual consistency.
  discardDestructiveText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.surface,
  },
});
