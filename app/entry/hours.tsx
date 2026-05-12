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
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { useToastStore } from '../../store/useToastStore';
import {
  adjustHours,
  formatEntryHours,
  setHoursValue,
} from '../../utils/hourMath';
import { getMonday, getWeekDays } from '../../utils/dateHelpers';
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

  const today = useMemo(() => new Date(), []);
  const monday = useMemo(() => getMonday(today), [today]);
  const visibleDays = useMemo(() => getWeekDays(monday, WEEKDAYS), [monday]);

  const user = useAuthStore((s) => s.user);
  const flatProjects = useProjectStore((s) => s.flatProjects);
  const selectedDate = useEntryStore((s) => s.selectedDate);
  const setSelectedDate = useEntryStore((s) => s.setSelectedDate);
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

  const [hours, setHours] = useState(0);
  // The base button (1–8) the user tapped to seed the total. Tracked
  // independently of `hours` so applying a modifier (+.25 etc.) doesn't
  // visually un-select the base button — the previous "highlight === total
  // exactly matches button value" heuristic broke the moment a modifier
  // shifted the total. Cleared on Clear and on tapping a different base.
  // Stays null in edit mode (we can't recover which base the user picked
  // originally), which renders all base buttons unselected — correct.
  const [selectedBase, setSelectedBase] = useState<number | null>(null);
  const [memo, setMemo] = useState('');
  const [memoFocused, setMemoFocused] = useState(false);
  const [tappedChips, setTappedChips] = useState<Set<string>>(new Set());
  const [showMemoError, setShowMemoError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState(isEditing);

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
      const result = await getMemoSuggestions(targetProject.id, phaseCode);
      if (!cancelled) setSuggestions(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [targetProject, phaseCode]);

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

  const onTapChip = (chip: string) => {
    Haptics.selectionAsync().catch(() => {});
    const trimmed = memo.trim();
    const next = trimmed.length === 0 ? chip : `${trimmed}, ${chip}`;
    setMemo(next.slice(0, MEMO_MAX));
    setTappedChips((prev) => new Set(prev).add(chip));
    if (showMemoError) setShowMemoError(false);
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
        showToast('Saved locally — will retry when BQE is reachable.', 'info');
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
        <Stack.Screen
          options={{
            title: isEditing ? 'Edit entry' : 'Log time',
            headerBackTitle: '',
            headerBackButtonDisplayMode: 'minimal',
          }}
        />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // useHeaderHeight returns the live measured nav-bar height (accounting for
  // status bar + safe-area insets). The previous version used no offset, so
  // the keyboard could push the Submit button up but the nav bar would
  // overlap the top of the scroll content. With this offset, KeyboardAvoiding
  // accounts for both.
  const headerHeight = useHeaderHeight();

  // iOS InputAccessoryView ID. The TextInput references this id so the
  // accessory view docks above the keyboard while the memo field is focused.
  const memoAccessoryId = 'memo-input-accessory';

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen
        options={{
          title: headerTitle,
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />

      <View style={styles.daySelectorWrap}>
        <WeekBar
          days={visibleDays}
          selectedDate={selectedDate}
          today={today}
          onSelectDay={setSelectedDate}
        />
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
            }}
            onFocus={() => setMemoFocused(true)}
            onBlur={() => setMemoFocused(false)}
            placeholder="Tap a suggestion or type…"
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

          {suggestions.chips.length > 0 ? (
            <View style={styles.suggestionsArea}>
              <Text style={styles.suggestionsLabel}>{suggestions.label}</Text>
              <View style={styles.chipsRow}>
                {suggestions.chips.map((chip) => (
                  <MemoChip
                    key={chip}
                    label={chip}
                    selected={tappedChips.has(chip)}
                    onPress={() => onTapChip(chip)}
                  />
                ))}
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
