import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import * as Haptics from 'expo-haptics';

import { colors } from '../../theme';
import { WeekBar } from '../../components/WeekBar';
import { MemoChip } from '../../components/MemoChip';
import { PhasePill } from '../../components/PhasePill';
import { HeaderHomeButton } from '../../components/HeaderHomeButton';
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { useToastStore } from '../../store/useToastStore';
import {
  adjustHours,
  formatEntryHours,
  setHoursValue,
} from '../../utils/hourMath';
import { fromIsoDay, getMonday, getSunday, getWeekDays, toIsoDay } from '../../utils/dateHelpers';
import { useToday } from '../../hooks/useToday';
import {
  REPEAT_THRESHOLD,
  REPEAT_TIMEOUT_MS,
  getRepeatMemoCounts,
  isMemoRepeated,
  normalizeMemo,
} from '../../utils/repeatMemoNudge';
import {
  MemoSuggestions,
  getMemoSuggestions,
} from '../../services/memos/suggestions';
import {
  getEntryLockReason,
  isEntryEditable,
  loadEntryById,
  lockReasonMessage,
} from '../../services/bqe/timeentry';
import {
  MEMO_MAX,
  MEMO_MIN,
  validateEntryDate,
  validateHours,
  validateMemo,
} from '../../utils/validation';
import { formatError, logError } from '../../services/errors';
import { resolveActivityForEntry } from '../../services/activitySelection/resolver';
import type { LocalTimeEntry } from '../../db/schema';

const WEEKDAYS = 5;
const BASE_HOURS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

// Stable module-scope reference for the header-right slot — prevents
// inline arrow churn on every render, which was hypothesised as the
// trigger for expo-router rebuilding nav state at sync completion.
const renderHeaderHomeButton = () => <HeaderHomeButton />;

// Stable parts of the Stack.Screen options. Title is dynamic so the
// final options object is composed via useMemo inside the component
// with `title` as the only changing input.
const HOURS_SCREEN_OPTIONS_BASE = {
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
  headerRight: renderHeaderHomeButton,
};

interface Modifier {
  label: string;
  delta?: number;
  reset?: boolean;
}

const MODIFIERS: Modifier[] = [
  { label: '− .25', delta: -0.25 },
  { label: '+ .25', delta: 0.25 },
  { label: '+ .50', delta: 0.5 },
  { label: 'Clear', reset: true },
];

export default function HoursEntryScreen() {
  const router = useRouter();
  const { projectId: rawProjectId, entryId } = useLocalSearchParams<{
    projectId?: string;
    entryId?: string;
  }>();
  // useHeaderHeight returns the live measured nav-bar height (accounting
  // for status bar + safe-area insets). Consumed by KeyboardAvoidingView
  // below as the vertical offset so the keyboard pushes the submit button
  // up cleanly without the nav bar overlapping the top of the scroll.
  //
  // MUST be called above every early return in this component — the hook
  // calls useContext internally, and conditionally skipping it (by hitting
  // the loading-state early-return) makes React's hook-order check fire:
  //   "React has detected a change in the order of Hooks called by
  //    HoursEntryScreen."
  // The edit-mode path hit exactly this: loadingEntry starts true in edit
  // mode, the early return runs, then once loadedEntry resolves the next
  // render falls through to the main body and useHeaderHeight gets called
  // for the first time. Two consecutive renders with different hook
  // counts. Keeping the call up here keeps the count stable.
  const headerHeight = useHeaderHeight();

  const user = useAuthStore((s) => s.user);
  const flatProjects = useProjectStore((s) => s.flatProjects);
  const selectedDate = useEntryStore((s) => s.selectedDate);
  const setSelectedDate = useEntryStore((s) => s.setSelectedDate);

  // `today` is the device's actual today — fed to WeekBar's `today` prop
  // ONLY for the today-marker (accent day letter). It does NOT drive the
  // visible week (that derives from selectedDate). Live via useToday so the
  // marker stays correct across an overnight background-resume (audit H-1).
  const today = useToday();

  // Visible week is derived from selectedDate (the entry store's single
  // source of truth) so a past-week selection on home carries through to
  // the entry flow. Pre-fix, monday/sunday/visibleDays were pinned to
  // `new Date()` and ignored which week the user was actually viewing.
  //
  // Parsing is defensive: empty/malformed/stale selectedDate falls back
  // to today so the screen never crashes. fromIsoDay uses the local-time
  // Date constructor (`new Date(y, m-1, d)`), so the parse is timezone-
  // safe — no UTC midnight interpretation, no day-boundary shift in
  // negative-UTC timezones.
  const parsedSelectedDate = useMemo(() => {
    if (selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      const d = fromIsoDay(selectedDate);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }, [selectedDate]);
  const monday = useMemo(() => getMonday(parsedSelectedDate), [parsedSelectedDate]);
  const sunday = useMemo(() => getSunday(parsedSelectedDate), [parsedSelectedDate]);
  const visibleDays = useMemo(() => getWeekDays(monday, WEEKDAYS), [monday]);
  const submitEntry = useEntryStore((s) => s.submitEntry);
  const saveEntryEdits = useEntryStore((s) => s.saveEntryEdits);
  const showToast = useToastStore((s) => s.show);

  const editingId = entryId ? Number(entryId) : null;
  const isEditing = editingId !== null && Number.isFinite(editingId);

  const [loadedEntry, setLoadedEntry] = useState<LocalTimeEntry | null>(null);
  const projectId = isEditing ? loadedEntry?.projectId ?? null : rawProjectId ?? null;

  const targetProject = useMemo(
    () => (projectId ? flatProjects.find((p) => p.id === projectId) ?? null : null),
    [flatProjects, projectId],
  );
  const parentProject = useMemo(() => {
    if (!targetProject) return null;
    if (!targetProject.isPhase) return targetProject;
    return flatProjects.find((p) => p.id === targetProject.parentId) ?? null;
  }, [targetProject, flatProjects]);

  const phaseCode = targetProject?.isPhase ? targetProject.phaseCode : null;
  const headerTitle = parentProject?.name ?? targetProject?.name ?? 'Log time';
  // Memoised options objects keyed on the dynamic title strings. Pairs
  // with HOURS_SCREEN_OPTIONS_BASE at module scope so the only thing
  // that can change the options' identity is an actual title change.
  const loadingScreenOptions = useMemo(
    () => ({
      ...HOURS_SCREEN_OPTIONS_BASE,
      title: isEditing ? 'Edit entry' : 'Log time',
    }),
    [isEditing],
  );
  const mainScreenOptions = useMemo(
    () => ({ ...HOURS_SCREEN_OPTIONS_BASE, title: headerTitle }),
    [headerTitle],
  );

  // Draft-restore on mount: in NEW-entry mode, look up any prior in-flight
  // draft keyed by (projectId, selectedDate) and seed the four drafted
  // fields. Lazy useState initializers run exactly once at mount with no
  // subscription to the store — subsequent draft writes from our own
  // write effect (below) don't loop back as state churn. Edit mode skips
  // restore entirely (drafts are NEW-entry only); same with the
  // project-still-loading edge case (targetProject?.id null at synchronous
  // first render — accept the rare flicker rather than wire an async
  // restore path).
  const initialDraft = useMemo(() => {
    if (isEditing || !targetProject?.id) return null;
    return useEntryStore.getState().getDraft(targetProject.id, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [hours, setHours] = useState<number>(() => initialDraft?.hours ?? 0);
  // The base button (1–8) the user tapped to seed the total. Tracked
  // independently of `hours` so applying a modifier (+.25 etc.) doesn't
  // visually un-select the base button — the previous "highlight === total
  // exactly matches button value" heuristic broke the moment a modifier
  // shifted the total. Cleared on Clear and on tapping a different base.
  // Stays null in edit mode (we can't recover which base the user picked
  // originally), which renders all base buttons unselected — correct.
  const [selectedBase, setSelectedBase] = useState<number | null>(
    () => initialDraft?.selectedBase ?? null,
  );
  const [memo, setMemo] = useState<string>(() => initialDraft?.memo ?? '');
  const [memoFocused, setMemoFocused] = useState(false);
  const [tappedChips, setTappedChips] = useState<Set<string>>(
    () => new Set(initialDraft?.tappedChips ?? []),
  );
  const [showMemoError, setShowMemoError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState(isEditing);

  // Repeat-memo nudge state — see utils/repeatMemoNudge.ts for the full
  // mechanism. Counts are keyed by normalised (lowercase-trimmed) memo.
  // `primedChip` holds the original chip label (not normalised) so the
  // hint line and the styled-chip lookup can compare by exact label.
  // `primedAt` carries the timestamp so the auto-clear timer + the
  // confirm-window check have one source of truth.
  const [repeatCounts, setRepeatCounts] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [primedChip, setPrimedChip] = useState<string | null>(null);
  const [primedAt, setPrimedAt] = useState<number | null>(null);

  const [suggestions, setSuggestions] = useState<MemoSuggestions>({
    label: 'Loading suggestions',
    chips: [],
    hasHistory: false,
  });

  useEffect(() => {
    if (!isEditing || editingId === null) return;
    let cancelled = false;
    (async () => {
      setLoadingEntry(true);
      const found = await loadEntryById(editingId);
      if (cancelled) return;
      if (found) {
        setLoadedEntry(found);
        setHours(found.hours);
        setMemo(found.memo ?? '');
        setSelectedDate(found.date);
      }
      setLoadingEntry(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isEditing, editingId, setSelectedDate]);

  useEffect(() => {
    if (!targetProject) return;
    let cancelled = false;
    (async () => {
      const result = await getMemoSuggestions(targetProject.id, phaseCode, targetProject?.name);
      if (!cancelled) setSuggestions(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [targetProject, phaseCode]);

  // Draft-write effect: persist the four drafted fields back to
  // useEntryStore so a navigation-away-and-back can restore them. NEW-
  // entry mode only; edit mode bypasses the draft layer. Writes are
  // unconditional (incl. empty state) so the in-store draft always
  // reflects the latest field values without an extra dirty-check pass.
  // tappedChips is a Set in component state; serialised as string[] for
  // the store shape.
  useEffect(() => {
    if (isEditing) return;
    if (!targetProject?.id) return;
    useEntryStore.getState().setDraft(targetProject.id, selectedDate, {
      hours,
      selectedBase,
      memo,
      tappedChips: Array.from(tappedChips),
      updatedAt: Date.now(),
    });
  }, [hours, selectedBase, memo, tappedChips, targetProject?.id, selectedDate, isEditing]);

  // Repeat-memo nudge: fetch this-week submission counts for every chip
  // the user is about to see, so subsequent chip taps can intercept the
  // 4th-and-beyond use of any single memo. Skip in edit mode — the
  // existing entry's memo isn't a chip tap, and counting it against
  // itself would create a confusing prefilled+primed state.
  useEffect(() => {
    if (isEditing) return;
    if (!user?.id) return;
    if (suggestions.chips.length === 0) return;
    let cancelled = false;
    const weekStartIso = toIsoDay(monday);
    const weekEndIso = toIsoDay(sunday);
    getRepeatMemoCounts(user.id, weekStartIso, weekEndIso, suggestions.chips)
      .then((map) => {
        if (cancelled) return;
        setRepeatCounts(map);
        // Diagnostic — log ONLY the memos at threshold so a quiet week
        // doesn't fill the in-app buffer with empty arrays. Matches the
        // [jot:scan-lookup] log pattern from the scan-filter work.
        const atThreshold = Array.from(map.entries())
          .filter(([, n]) => n >= REPEAT_THRESHOLD)
          .map(([k, n]) => `"${k}"=${n}`);
        if (atThreshold.length > 0) {
          console.log(
            `[jot:repeat-nudge] ${atThreshold.length} chip(s) at threshold: ${atThreshold.join(', ')} threshold=${REPEAT_THRESHOLD}`,
          );
        }
      })
      .catch((err) => {
        // Repeat counts are advisory — failing the fetch shouldn't block
        // entry. Leave the map empty so every chip behaves as
        // non-repeated, and the user submits normally.
        console.warn(
          '[jot:repeat-nudge] count fetch failed:',
          err instanceof Error ? err.message : err,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isEditing, user?.id, suggestions.chips, monday, sunday]);

  // Auto-clear the primed state after REPEAT_TIMEOUT_MS. Each
  // setPrimedAt(Date.now()) call updates the dep, the prior timer is
  // cleaned up, and a fresh one starts — so re-priming (tapping a
  // different repeated chip) restarts the window cleanly.
  useEffect(() => {
    if (primedAt === null) return;
    const timer = setTimeout(() => {
      setPrimedChip(null);
      setPrimedAt(null);
    }, REPEAT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [primedAt]);

  const editingLockReason = loadedEntry ? getEntryLockReason(loadedEntry) : null;
  const editingLocked = loadedEntry ? !isEntryEditable(loadedEntry) : false;

  const hoursScale = useRef(new Animated.Value(1)).current;
  const isFirstHourRender = useRef(true);
  useEffect(() => {
    if (isFirstHourRender.current) {
      isFirstHourRender.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(hoursScale, {
        toValue: 1.18,
        duration: 80,
        useNativeDriver: true,
      }),
      Animated.spring(hoursScale, {
        toValue: 1,
        useNativeDriver: true,
        friction: 5,
        tension: 200,
      }),
    ]).start();
  }, [hours, hoursScale]);

  const onTapBase = (n: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setHours(setHoursValue(n));
    setSelectedBase(n);
    if (showMemoError) setShowMemoError(false);
  };

  const onTapModifier = (m: Modifier) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (m.reset) {
      // Clear resets both — total goes to 0 and no base is selected.
      setHours(0);
      setSelectedBase(null);
    } else if (m.delta !== undefined) {
      // Increment/decrement: total only. selectedBase stays so the
      // highlight persists through the modifier sequence.
      setHours((current) => adjustHours(current, m.delta!));
    }
  };

  // Existing "fill the memo with this chip" behaviour, factored out so
  // both the non-repeated tap path and the confirmed-repeated tap path
  // share one implementation.
  const fillMemoWithChip = (chip: string) => {
    const trimmed = memo.trim();
    const next = trimmed.length === 0 ? chip : `${trimmed}, ${chip}`;
    setMemo(next.slice(0, MEMO_MAX));
    setTappedChips((prev) => new Set(prev).add(chip));
    if (showMemoError) setShowMemoError(false);
  };

  const clearPrimed = () => {
    setPrimedChip(null);
    setPrimedAt(null);
  };

  const onTapChip = (chip: string) => {
    Haptics.selectionAsync().catch(() => {});
    const count = repeatCounts.get(normalizeMemo(chip)) ?? 0;
    const repeated = isMemoRepeated(count);

    // Non-repeated chip — normal fill behaviour. If a different chip
    // happened to be primed, the user just bypassed the nudge by
    // picking something else; clear the primed state.
    if (!repeated) {
      if (primedChip) clearPrimed();
      fillMemoWithChip(chip);
      return;
    }

    // Repeated chip + same chip already primed within the window =
    // confirmation. Fill the memo and clear primed. The state-machine
    // contract: a second tap of the SAME primed chip within the timeout
    // is the only way to fill a repeated memo via chip; everything else
    // (re-prime, type custom text, wait) cancels.
    if (
      primedChip === chip &&
      primedAt !== null &&
      Date.now() - primedAt < REPEAT_TIMEOUT_MS
    ) {
      clearPrimed();
      fillMemoWithChip(chip);
      return;
    }

    // First tap (no primed chip) OR different repeated chip (re-prime)
    // OR previously primed chip but the window expired (the timer
    // useEffect should have cleared, but check defensively in case the
    // user tapped exactly at the boundary). Start a fresh primed window
    // on this chip; do NOT fill the memo.
    setPrimedChip(chip);
    setPrimedAt(Date.now());
  };

  const memoLength = memo.trim().length;
  const memoValid = memoLength >= MEMO_MIN;
  const canSubmit =
    hours > 0 && memoValid && !submitting && !!user?.id && !editingLocked;

  // Theme B memo border logic:
  //   - validation failed → 1.5px danger
  //   - currently focused → 1.5px accent
  //   - otherwise (incl. valid+blurred) → hairline neutral
  // Intentionally NO "accent on valid" treatment. Validity is signalled
  // by the submit button enabling, not by colouring the input — keeps
  // the form quiet when there's nothing wrong.
  const memoHasError = showMemoError && !memoValid;
  const memoBorderColor = memoHasError
    ? colors.danger
    : memoFocused
      ? colors.accent
      : colors.border;
  const memoBorderWidth = memoHasError || memoFocused ? 1.5 : StyleSheet.hairlineWidth;

  const onSubmit = async () => {
    if (!user?.id || !targetProject) return;

    const hoursCheck = validateHours(hours);
    if (!hoursCheck.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      showToast(hoursCheck.message ?? 'Invalid hours', 'error');
      return;
    }

    const memoCheck = validateMemo(memo);
    if (!memoCheck.ok) {
      setShowMemoError(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      showToast(memoCheck.message ?? 'Memo required', 'error');
      return;
    }

    const dateCheck = validateEntryDate(selectedDate);
    if (!dateCheck.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      showToast(dateCheck.message ?? 'Invalid date', 'error');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    const memoText = memo.trim();
    const memoPreview = memoText.length > 28 ? `${memoText.slice(0, 28)}…` : memoText;

    if (isEditing && loadedEntry) {
      setSubmitting(true);
      const result = await saveEntryEdits(loadedEntry.id, {
        hours,
        memo: memoText,
        date: selectedDate,
        isBillable: loadedEntry.isBillable,
      });
      setSubmitting(false);
      if (result.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        showToast('Entry updated', 'success');
        goHome();
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        logError('hours.saveEdits', result.error);
        showToast(`Update failed: ${formatError(new Error(result.error)).userMessage}`, 'error');
      }
      return;
    }

    // Resolver picks an activity allowed for this project's BQE activity
    // group(s). Phase ids are fine — the resolver climbs to the parent
    // project to find the group binding. This is what dodges the 409
    // ProjectControlLimitation: the activity must be a member of the
    // project's allowed group.
    const resolved = resolveActivityForEntry({ projectId: targetProject.id });
    if (resolved.activityId === null) {
      showToast(
        'No activity available for this project — please sync, or contact your admin',
        'error',
      );
      return;
    }
    if (resolved.source === 'firm-fallback' && __DEV__) {
      // The resolver already logged [jot:activity-fallback]; not shown to
      // user to avoid alarming them.
      console.log('[jot:hours] using firm-fallback activity for', targetProject.id);
    }
    const activityId = resolved.activityId;

    setSubmitting(true);
    const result = await submitEntry({
      projectId: targetProject.id,
      activityId,
      resourceId: user.id,
      date: selectedDate,
      hours,
      memo: memoText,
      isBillable: true,
      source: 'manual',
    });
    setSubmitting(false);

    // Clear the draft regardless of submit outcome. submitEntry inserts the
    // local SQLite row UNCONDITIONALLY before the BQE call (see
    // store/useEntryStore.ts submitEntry — comment at the catch block:
    // "the entry is already saved locally above, so nothing is lost"), so
    // every outcome here (ok, queued, httpError, network failure) means a
    // local row exists. Preserving the draft past completion would create
    // a phantom: user navigates back, sees the draft restored, doesn't
    // realise the entry is already in their pending queue, and ends up
    // duplicating it.
    useEntryStore.getState().clearDraft(targetProject.id, selectedDate);

    if (result.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      if (result.queued) {
        showToast('Saved locally — will sync when online', 'info');
      } else {
        showToast(`${formatEntryHours(hours)}h logged — ${memoPreview}`, 'success');
      }
      goHome();
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      logError('hours.submit', result.error);
      if (result.httpError) {
        // BQE actively rejected the request — surface the real reason so the
        // user can fix the underlying issue (e.g. ProjectControlLimitation
        // when the activity isn't in the project's group). The entry was
        // already saved locally as a fallback, but presenting "saved, will
        // retry" here would mislead — the retry will hit the same error.
        showToast(result.error, 'error');
      } else {
        showToast('Saved locally — will retry when the server is reachable.', 'info');
      }
      goHome();
    }
  };

  const goHome = () => {
    if (router.canDismiss?.()) {
      router.dismissAll();
    } else {
      router.replace('/');
    }
  };

  if (loadingEntry || (isEditing && !loadedEntry) || !targetProject) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={loadingScreenOptions} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // iOS InputAccessoryView ID. The TextInput references this id so the
  // accessory view docks above the keyboard while the memo field is focused.
  // (`headerHeight` is captured at the top of the component — see comment
  // there for why it can't live here below the early return.)
  const memoAccessoryId = 'memo-input-accessory';

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen options={mainScreenOptions} />

      <View style={styles.daySelectorWrap}>
        <WeekBar
          days={visibleDays}
          selectedDate={selectedDate}
          today={today}
          onSelectDay={setSelectedDate}
        />
        {/*
          Unambiguous full-date callout under the WeekBar. The compact
          day letters (M, T, W, Th, F) read identically across weeks; this
          label tells the user e.g. "Thursday, May 22" so a past-week
          selection can't be mistaken for the current week. Reads from
          parsedSelectedDate so it always agrees with the WeekBar
          (both derive from the same source).
        */}
        <Text style={styles.dateLabel}>
          {parsedSelectedDate.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </Text>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {editingLocked && editingLockReason ? (
          <View style={styles.lockedBanner}>
            <Text style={styles.lockedBannerText}>
              {lockReasonMessage(editingLockReason)}
            </Text>
          </View>
        ) : null}

        {phaseCode ? (
          <View style={styles.headerArea}>
            <PhasePill code={phaseCode} size="md" />
          </View>
        ) : null}

        <View style={styles.hoursDisplay}>
          <Animated.View
            style={[styles.hoursRow, { transform: [{ scale: hoursScale }] }]}
          >
            <Text style={styles.hoursValue}>{formatEntryHours(hours)}</Text>
            <Text style={styles.hoursUnit}>h</Text>
          </Animated.View>
        </View>

        <View style={styles.baseGrid}>
          {BASE_HOURS.map((n) => {
            // Highlight tracks the LAST-TAPPED base, not the current total.
            // A modifier shifting the total to 2.25 must not un-select "2".
            const selected = selectedBase === n;
            return (
              <Pressable
                key={n}
                onPress={() => onTapBase(n)}
                style={({ pressed }) => [
                  styles.baseButton,
                  selected && styles.baseButtonSelected,
                  pressed && styles.baseButtonPressed,
                ]}
              >
                <Text style={[styles.baseButtonText, selected && styles.baseButtonTextSelected]}>
                  {n}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.modifierRow}>
          {MODIFIERS.map((m) => (
            <Pressable
              key={m.label}
              onPress={() => onTapModifier(m)}
              style={({ pressed }) => [
                styles.modifierButton,
                m.reset && styles.modifierButtonClear,
                pressed && styles.modifierButtonPressed,
              ]}
            >
              <Text style={[styles.modifierText, m.reset && styles.modifierTextClear]}>
                {m.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.memoSection}>
          <View style={styles.memoLabelRow}>
            <Text style={styles.memoLabel}>What did you work on?</Text>
            <Text style={styles.requiredLabel}>required</Text>
          </View>

          <TextInput
            value={memo}
            onChangeText={(t) => {
              setMemo(t.slice(0, MEMO_MAX));
              if (showMemoError && t.trim().length >= MEMO_MIN) setShowMemoError(false);
              // Any keystroke means the user is now providing their own
              // text — the chip-tap nudge no longer applies. Clear the
              // primed state so the placeholder swap and hint line
              // disappear immediately. (Placeholder isn't visible while
              // the user is typing anyway, but clearing keeps the
              // state-machine invariants tight.)
              if (primedChip) clearPrimed();
            }}
            onFocus={() => setMemoFocused(true)}
            onBlur={() => setMemoFocused(false)}
            placeholder={
              primedChip ? 'What specifically today?' : 'Tap a suggestion or type…'
            }
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.memoInput,
              { borderColor: memoBorderColor, borderWidth: memoBorderWidth },
            ]}
            maxLength={MEMO_MAX}
            multiline
            inputAccessoryViewID={Platform.OS === 'ios' ? memoAccessoryId : undefined}
          />

          {memoHasError ? (
            <Text style={styles.memoError}>
              Add a few words about what you worked on
            </Text>
          ) : memo.length > 0 ? (
            <Text style={styles.memoCounter}>
              {memo.length}/{MEMO_MAX}
            </Text>
          ) : null}

          {/*
            Repeat-memo nudge hint. Renders only when a repeated chip is
            primed and waiting on a second tap. Single line, 12px,
            textSecondary — quiet enough not to dominate, explicit
            enough that the "tap again to use" gesture is discoverable.
          */}
          {primedChip ? (
            <Text style={styles.repeatHint}>
              {`Tap '${primedChip}' again to use it anyway`}
            </Text>
          ) : null}

          {suggestions.chips.length > 0 ? (
            <View style={styles.suggestionsArea}>
              <Text style={styles.suggestionsLabel}>{suggestions.label}</Text>
              <View style={styles.chipsRow}>
                {suggestions.chips.map((chip) => {
                  const count = repeatCounts.get(normalizeMemo(chip)) ?? 0;
                  return (
                    <MemoChip
                      key={chip}
                      label={chip}
                      selected={tappedChips.has(chip)}
                      repeated={isMemoRepeated(count)}
                      primed={primedChip === chip}
                      onPress={() => onTapChip(chip)}
                    />
                  );
                })}
              </View>
            </View>
          ) : null}
        </View>

        <Pressable
          onPress={onSubmit}
          disabled={!canSubmit}
          style={({ pressed }) => [
            styles.submit,
            !canSubmit && styles.submitDisabled,
            pressed && canSubmit && styles.submitPressed,
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={colors.surface} />
          ) : (
            <Text
              style={[styles.submitText, !canSubmit && styles.submitTextDisabled]}
            >
              {isEditing ? 'Update entry' : 'Log time'}
            </Text>
          )}
        </Pressable>
      </ScrollView>

      {/*
        iOS-only accessory bar that docks above the keyboard while the memo
        field is focused. Gives a "Done" affordance to dismiss; the only way
        to dismiss a multiline TextInput on iOS otherwise is a swipe down,
        which testers consistently couldn't discover. Android renders the
        system back/down button by default so we skip the accessory there.

        Placement: RN renders InputAccessoryView via a separate native layer
        above the keyboard regardless of JSX nesting — the binding from the
        TextInput is purely via inputAccessoryViewID ↔ nativeID. We keep it
        as a sibling of the ScrollView so the JSX shape reads cleanly.
      */}
      {Platform.OS === 'ios' ? (
        <InputAccessoryView nativeID={memoAccessoryId}>
          <View style={styles.accessoryBar}>
            <Pressable
              onPress={() => Keyboard.dismiss()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Dismiss keyboard"
              style={({ pressed }) => [
                styles.accessoryDone,
                pressed && styles.accessoryDonePressed,
              ]}
            >
              <Text style={styles.accessoryDoneText}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 48,
  },
  daySelectorWrap: {
    paddingVertical: 12,
  },
  // Subtle secondary-color full-date label sitting directly under the
  // WeekBar. Centered to anchor under the day-letter row. Light vertical
  // gap from the pills above.
  dateLabel: {
    marginTop: 8,
    textAlign: 'center',
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  // Lock banner — kept on the prior warmth-warning treatment (warningTint
  // bg + the dark amber #92400E text). Same pattern the login session-
  // expired banner uses; consistent across screens.
  lockedBanner: {
    backgroundColor: colors.warningTint,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 4,
    marginBottom: 8,
  },
  lockedBannerText: {
    color: '#92400E',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  headerArea: {
    alignItems: 'center',
    paddingTop: 4,
  },
  // The hours display is the centerpiece. 96px near-black numerals on
  // cream — the biggest single piece of text in the app. System sans
  // (not Architects Daughter) because clean numerals matter more than
  // personality here. Tabular nums so 1.25 / 8.50 / 2.75 don't visually
  // bob as the digit widths change.
  hoursDisplay: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  hoursRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  hoursValue: {
    fontSize: 96,
    fontWeight: '500',
    color: colors.text,
    fontVariant: ['tabular-nums'],
    lineHeight: 100,
  },
  hoursUnit: {
    fontSize: 32,
    fontWeight: '400',
    color: colors.textSecondary,
    marginLeft: 6,
  },
  baseGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  // Base hour buttons (1–8) — cream surface, hairline border, primary
  // text. Selected one flips to solid accent + cream text. The grid is
  // 4 cols × 2 rows.
  //
  // Width: 22% (not 23%). Math check on a standard iPhone container
  // (~311px wide after the screen's 16px horizontal padding):
  //   4 × 22% = 88%, leaving 12% (~37px) for 3 × 12px gaps = 36px.
  //   Fits with 1px slack.
  // 23% overflowed (4×23% + 3×12 = 92% + 36px = 322px > 311px) and
  // forced the grid to wrap into 3 cols × 3 rows on standard widths.
  baseButton: {
    width: '22%',
    aspectRatio: 1,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  baseButtonSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  baseButtonPressed: {
    backgroundColor: colors.accentTint,
  },
  baseButtonText: {
    fontSize: 22,
    fontWeight: '500',
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  baseButtonTextSelected: {
    color: colors.surface,
  },
  modifierRow: {
    flexDirection: 'row',
    gap: 10,
    // Tight gap to the base grid above — the 1–8 tiles and the
    // −.25 / +.25 / +.50 / Clear row are one logical control. Keep
    // this small so they read as a single block; the section break
    // is the larger gap to the memo section below.
    marginTop: 16,
  },
  // Modifier buttons (−.25 / +.25 / +.50 / Clear) — same cream tile as
  // the base buttons but a wider pill shape. Clear stays surface-cream
  // but takes a quieter text colour (secondary) so it doesn't read as
  // a destructive accent button.
  modifierButton: {
    flex: 1,
    height: 48,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modifierButtonClear: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  modifierButtonPressed: {
    backgroundColor: colors.accentTint,
  },
  modifierText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  // Clear: secondary text colour (not danger) — destructive in effect
  // but visually quieter. The orange accent stays reserved for actions
  // the user is meant to act on, not retreat from.
  modifierTextClear: {
    color: colors.textSecondary,
  },
  memoSection: {
    // Section divider — larger gap signals "new control group" after
    // the base+modifier pair above. Roughly 2× the base→modifier gap.
    marginTop: 32,
    gap: 8,
  },
  memoLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  memoLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  // "required" indicator: accent text, NOT red. Red stays reserved for
  // actual validation errors; accent is the visual emphasis Theme B
  // gives to "this matters".
  requiredLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.accent,
  },
  memoCounter: {
    alignSelf: 'flex-end',
    fontSize: 12,
    color: colors.textTertiary,
  },
  // Inline validation message — appears below the input only when a
  // submit attempt failed validation. Stays absent on first paint to
  // avoid pre-emptively scolding the user.
  memoError: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.danger,
    marginTop: 2,
  },
  // Repeat-nudge discoverability hint — explains the "tap again to
  // confirm" gesture so users can complete a repeated-memo submission
  // without confusion. Lives between the input and the chips row,
  // visible only during the primed window.
  repeatHint: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.textSecondary,
    marginTop: 4,
  },
  memoInput: {
    minHeight: 80,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
    textAlignVertical: 'top',
  },
  // Accessory bar that docks above the keyboard on iOS. Subtle surface
  // and a top hairline so it visually separates from the keyboard's
  // tinted background without competing for attention.
  accessoryBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  accessoryDone: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  accessoryDonePressed: {
    opacity: 0.6,
  },
  accessoryDoneText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '500',
  },
  suggestionsArea: {
    marginTop: 12,
    gap: 10,
  },
  // Same treatment as the home section header — sentence case, 13/500,
  // textSecondary, slight positive tracking. Theme B drops uppercase
  // chrome across the board.
  suggestionsLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    letterSpacing: 0.2,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  // Full-width submit pill — radius = height/2. Disabled state uses the
  // disabledBg/disabledText tokens (matching the login button's disabled
  // treatment) instead of fading the accent.
  submit: {
    marginTop: 32,
    backgroundColor: colors.accent,
    borderRadius: 28,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitDisabled: {
    backgroundColor: colors.disabledBg,
  },
  submitPressed: {
    backgroundColor: colors.accentPressed,
  },
  submitText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '500',
  },
  submitTextDisabled: {
    color: colors.disabledText,
  },
});
