import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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
import * as Haptics from 'expo-haptics';

import { colors } from '../../theme';
import { DaySelector } from '../../components/DaySelector';
import { MemoChip } from '../../components/MemoChip';
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
import { isEntryLocked, loadEntryById } from '../../services/bqe/timeentry';
import {
  MEMO_MAX,
  MEMO_MIN,
  validateEntryDate,
  validateHours,
  validateMemo,
} from '../../utils/validation';
import { formatError, logError } from '../../services/errors';
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
  const getDefaultActivityId = useProjectStore((s) => s.getDefaultActivityId);
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
  const projectColor = parentProject?.color ?? colors.accent;
  const headerTitle = parentProject?.name ?? targetProject?.name ?? 'Log time';

  const [hours, setHours] = useState(0);
  const [memo, setMemo] = useState('');
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

  const editingLocked = loadedEntry ? isEntryLocked(loadedEntry) : false;

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
    if (showMemoError) setShowMemoError(false);
  };

  const onTapModifier = (m: Modifier) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (m.reset) {
      setHours(0);
    } else if (m.delta !== undefined) {
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

  const memoBorderColor = showMemoError && !memoValid
    ? colors.danger
    : memoValid
      ? colors.accent
      : colors.border;

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

    const activityId = getDefaultActivityId();
    if (!activityId) {
      showToast('No activity available — sync with BQE Core first', 'error');
      return;
    }

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
      showToast('Saved locally — will retry when BQE is reachable.', 'info');
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
        <Stack.Screen options={{ title: isEditing ? 'Edit entry' : 'Log time' }} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: headerTitle }} />

      <DaySelector
        days={visibleDays}
        selectedDate={selectedDate}
        today={today}
        onSelectDay={setSelectedDate}
      />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {editingLocked ? (
          <View style={styles.lockedBanner}>
            <Text style={styles.lockedBannerText}>
              This entry is locked because it has been billed.
            </Text>
          </View>
        ) : null}

        <View style={styles.headerArea}>
          <View style={[styles.phaseBadge, { backgroundColor: projectColor }]}>
            <Text style={styles.phaseBadgeText}>{phaseCode ?? targetProject.name}</Text>
          </View>
        </View>

        <View style={styles.hoursDisplay}>
          <Animated.Text
            style={[styles.hoursValue, { transform: [{ scale: hoursScale }] }]}
          >
            {formatEntryHours(hours)}
          </Animated.Text>
          <Text style={styles.hoursUnit}>hours</Text>
        </View>

        <View style={styles.baseGrid}>
          {BASE_HOURS.map((n) => {
            const selected = hours === n;
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
            <View style={styles.requiredBadge}>
              <Text style={styles.requiredBadgeText}>required</Text>
            </View>
            {memo.length > 0 ? (
              <Text style={styles.memoCounter}>
                {memo.length}/{MEMO_MAX}
              </Text>
            ) : null}
          </View>

          <TextInput
            value={memo}
            onChangeText={(t) => {
              setMemo(t.slice(0, MEMO_MAX));
              if (showMemoError && t.trim().length >= MEMO_MIN) setShowMemoError(false);
            }}
            placeholder="Tap a suggestion or type…"
            placeholderTextColor={colors.muted}
            style={[styles.memoInput, { borderColor: memoBorderColor }]}
            maxLength={MEMO_MAX}
            multiline
          />

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
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.submitText}>{isEditing ? 'Update entry' : 'Log time'}</Text>
          )}
        </Pressable>
      </ScrollView>
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
  lockedBanner: {
    backgroundColor: '#FEF3C7',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 4,
    marginBottom: 8,
  },
  lockedBannerText: {
    color: '#92400E',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerArea: {
    alignItems: 'center',
    paddingTop: 4,
  },
  phaseBadge: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  phaseBadgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  hoursDisplay: {
    alignItems: 'center',
    paddingVertical: 28,
  },
  hoursValue: {
    fontSize: 80,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -2,
  },
  hoursUnit: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 4,
  },
  baseGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  baseButton: {
    width: '23.5%',
    aspectRatio: 1,
    borderRadius: 16,
    backgroundColor: colors.subtle,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  baseButtonSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  baseButtonPressed: {
    opacity: 0.75,
  },
  baseButtonText: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  baseButtonTextSelected: {
    color: '#FFFFFF',
  },
  modifierRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  modifierButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.subtle,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  modifierButtonClear: {
    backgroundColor: colors.background,
    borderColor: colors.border,
  },
  modifierButtonPressed: {
    opacity: 0.75,
  },
  modifierText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  modifierTextClear: {
    color: colors.danger,
  },
  memoSection: {
    marginTop: 28,
    gap: 8,
  },
  memoLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  memoLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  requiredBadge: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  requiredBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.danger,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  memoCounter: {
    marginLeft: 'auto',
    fontSize: 12,
    color: colors.muted,
  },
  memoInput: {
    minHeight: 64,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.background,
    textAlignVertical: 'top',
  },
  suggestionsArea: {
    marginTop: 6,
    gap: 8,
  },
  suggestionsLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  submit: {
    marginTop: 32,
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  submitDisabled: {
    backgroundColor: colors.border,
  },
  submitPressed: {
    opacity: 0.85,
  },
  submitText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
