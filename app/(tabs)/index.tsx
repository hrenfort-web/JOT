import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme';
import {
  addWeeks,
  formatHours,
  getMonday,
  getSunday,
  getWeekDays,
  isSameDay,
  startOfDay,
  toIsoDay,
} from '../../utils/dateHelpers';
import { WeekBar } from '../../components/WeekBar';
import { SummaryPill } from '../../components/SummaryPill';
import { ProjectCard } from '../../components/ProjectCard';
import { EntryRow } from '../../components/EntryRow';
import { FloatingActionButton } from '../../components/FloatingActionButton';
import { EmptyState } from '../../components/EmptyState';
import { OfflineBanner } from '../../components/OfflineBanner';
import { SubmitWeekCard } from '../../components/SubmitWeekCard';
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { useToastStore } from '../../store/useToastStore';
import { useReminderStore } from '../../store/useReminderStore';
import { runInitialSync } from '../../services/sync/initialSync';
import {
  getEntryLockReason,
  isEntryEditable,
  loadProjectIdsInRange,
  lockReasonMessage,
} from '../../services/bqe/timeentry';
import { useOnline } from '../../services/sync/connectivity';
import type { LocalProject, LocalTimeEntry } from '../../db/schema';
import type { ProjectNode } from '../../services/bqe/project';

const WEEKDAYS = 5;
const MAX_WEEK_OFFSET = 4;

export default function HomeScreen() {
  const router = useRouter();
  const today = useMemo(() => startOfDay(new Date()), []);

  const [weekOffset, setWeekOffset] = useState(0);
  const referenceDate = useMemo(() => addWeeks(today, weekOffset), [today, weekOffset]);
  const monday = useMemo(() => getMonday(referenceDate), [referenceDate]);
  const sunday = useMemo(() => getSunday(referenceDate), [referenceDate]);
  const visibleDays = useMemo(() => getWeekDays(monday, WEEKDAYS), [monday]);
  const friday = useMemo(() => visibleDays[visibleDays.length - 1], [visibleDays]);
  const isCurrentWeek = weekOffset === 0;
  const isPastWeek = weekOffset < 0;
  const isFutureWeek = weekOffset > 0;

  const user = useAuthStore((s) => s.user);
  const reminderPrefs = useReminderStore((s) => s.prefs);
  const targetPerDay = reminderPrefs.targetPerDay ?? 8;

  const tree = useProjectStore((s) => s.tree);
  const flatProjects = useProjectStore((s) => s.flatProjects);
  const refreshProjects = useProjectStore((s) => s.refresh);

  const weekEntries = useEntryStore((s) => s.weekEntries);
  const selectedDate = useEntryStore((s) => s.selectedDate);
  const setSelectedDate = useEntryStore((s) => s.setSelectedDate);
  const loadWeek = useEntryStore((s) => s.loadWeek);
  const isLoadingEntries = useEntryStore((s) => s.isLoading);
  const lastError = useEntryStore((s) => s.lastError);
  const deleteEntry = useEntryStore((s) => s.deleteEntry);
  const retryEntry = useEntryStore((s) => s.retryEntry);
  const submitWeek = useEntryStore((s) => s.submitWeek);
  const showToast = useToastStore((s) => s.show);
  const online = useOnline();

  const [bootstrapped, setBootstrapped] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSyncingFresh, setIsSyncingFresh] = useState(false);
  const [isSubmittingWeek, setIsSubmittingWeek] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [priorWeekParentIds, setPriorWeekParentIds] = useState<Set<string>>(new Set());

  const standardHours = (user?.standardHoursPerWeek as number | undefined) ?? 40;

  const refreshWeek = useCallback(async () => {
    if (!user?.id) return;
    await loadWeek(user.id, toIsoDay(monday), toIsoDay(sunday));
  }, [user?.id, loadWeek, monday, sunday]);

  useEffect(() => {
    if (!user?.id || bootstrapped) return;
    let cancelled = false;
    (async () => {
      setIsBootstrapping(true);
      try {
        await refreshProjects();
        if (useProjectStore.getState().flatProjects.length === 0) {
          setIsSyncingFresh(true);
          try {
            await runInitialSync();
          } finally {
            setIsSyncingFresh(false);
          }
          await refreshProjects();
        }
        await refreshWeek();
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
          setBootstrapped(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, bootstrapped, refreshProjects, refreshWeek]);

  useFocusEffect(
    useCallback(() => {
      if (bootstrapped) {
        refreshWeek();
      }
    }, [bootstrapped, refreshWeek]),
  );

  useEffect(() => {
    if (!bootstrapped) return;
    refreshWeek();
  }, [bootstrapped, weekOffset, refreshWeek]);

  useEffect(() => {
    setShowAllProjects(false);
    if (isCurrentWeek) {
      setSelectedDate(toIsoDay(today));
    } else {
      setSelectedDate(toIsoDay(monday));
    }
  }, [weekOffset, isCurrentWeek, monday, today, setSelectedDate]);

  useEffect(() => {
    if (!user?.id) return;
    const priorMonday = addWeeks(monday, -1);
    const priorSunday = addWeeks(sunday, -1);
    let cancelled = false;
    loadProjectIdsInRange(user.id, priorMonday, priorSunday)
      .then((phaseIds) => {
        if (cancelled) return;
        const parents = new Set<string>();
        const lookup = useProjectStore.getState().flatProjects;
        const phaseToParent = new Map<string, string>();
        for (const p of lookup) {
          if (p.isPhase && p.parentId) phaseToParent.set(p.id, p.parentId);
        }
        for (const phaseId of phaseIds) {
          const parent = phaseToParent.get(phaseId);
          if (parent) parents.add(parent);
        }
        setPriorWeekParentIds(parents);
      })
      .catch(() => {
        if (!cancelled) setPriorWeekParentIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, monday, sunday, flatProjects.length]);

  const hoursByDay = useMemo(() => buildHoursByDay(weekEntries), [weekEntries]);
  const phaseToParent = useMemo(() => buildPhaseToParent(flatProjects), [flatProjects]);
  const hoursByParent = useMemo(
    () => buildHoursByParent(weekEntries, phaseToParent),
    [weekEntries, phaseToParent],
  );
  const phaseLabelByParent = useMemo(
    () => buildPhaseLabelByParent(weekEntries, flatProjects, tree),
    [weekEntries, flatProjects, tree],
  );

  const projectBuckets = useMemo(
    () => bucketProjects(tree, hoursByParent, priorWeekParentIds),
    [tree, hoursByParent, priorWeekParentIds],
  );
  const visibleProjects = useMemo(() => {
    const { withCurrent, withPrior, others } = projectBuckets;
    if (showAllProjects) return [...withCurrent, ...withPrior, ...others];
    if (withCurrent.length === 0 && withPrior.length === 0) return others;
    return [...withCurrent, ...withPrior];
  }, [projectBuckets, showAllProjects]);
  const moreProjectsCount = projectBuckets.others.length;
  const showMoreToggle =
    moreProjectsCount > 0 &&
    (projectBuckets.withCurrent.length > 0 || projectBuckets.withPrior.length > 0);

  const totalHours = useMemo(
    () => weekEntries.reduce((sum, e) => sum + e.hours, 0),
    [weekEntries],
  );
  const remaining = Math.max(0, standardHours - totalHours);

  const projectsById = useMemo(
    () => new Map(flatProjects.map((p) => [p.id, p])),
    [flatProjects],
  );

  const dayEntries = useMemo(
    () =>
      weekEntries
        .filter((e) => e.date === selectedDate)
        .sort((a, b) => a.id - b.id),
    [weekEntries, selectedDate],
  );

  const draftEntries = useMemo(
    () =>
      weekEntries.filter(
        (e) =>
          e.syncStatus === 'synced' &&
          (e.submissionStatus === 'draft' ||
            e.submissionStatus === 'rejected' ||
            e.submissionStatus === null),
      ),
    [weekEntries],
  );
  const draftHours = useMemo(
    () => draftEntries.reduce((s, e) => s + e.hours, 0),
    [draftEntries],
  );
  const pendingWeekCount = useMemo(
    () => weekEntries.filter((e) => e.syncStatus !== 'synced').length,
    [weekEntries],
  );

  const handleSubmitWeek = () => {
    if (!user?.id || draftEntries.length === 0) return;
    const weekLabel = weekRangeLabel(monday, friday, false, false);
    Alert.alert(
      `Submit ${draftEntries.length} ${draftEntries.length === 1 ? 'entry' : 'entries'} (${formatHours(draftHours)}h)?`,
      `For the week of ${weekLabel}. You won't be able to edit them after.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit',
          onPress: async () => {
            setIsSubmittingWeek(true);
            const result = await submitWeek(user.id, toIsoDay(monday), toIsoDay(sunday));
            setIsSubmittingWeek(false);
            if (result.ok) {
              showToast('Week submitted!', 'success');
            } else {
              showToast(`Couldn't submit: ${result.error}`, 'error');
            }
          },
        },
      ],
    );
  };

  const handleEntryPress = (entry: LocalTimeEntry) => {
    const lockReason = getEntryLockReason(entry);
    if (lockReason) {
      showToast(lockReasonMessage(lockReason), 'info');
      return;
    }
    if (entry.syncStatus === 'failed') {
      Alert.alert(
        'Sync failed',
        entry.lastError ?? 'BQE rejected this entry.',
        [
          { text: 'Edit', onPress: () => goEdit(entry.id) },
          {
            text: 'Retry',
            onPress: async () => {
              const result = await retryEntry(entry.id);
              if (result.ok) {
                showToast('Entry submitted', 'success');
              } else {
                showToast(result.error, 'error');
              }
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }
    goEdit(entry.id);
  };

  const goEdit = (id: number) => {
    router.push({ pathname: '/entry/hours', params: { entryId: String(id) } });
  };

  const handleEntryDelete = (entry: LocalTimeEntry) => {
    if (!isEntryEditable(entry)) return;
    const projectName = displayNameForEntry(entry, projectsById);
    Alert.alert(
      `Delete ${formatHours(entry.hours)}h on ${projectName}?`,
      'This time entry will be removed from BQE Core.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const result = await deleteEntry(entry.id);
            if (result.ok) {
              showToast('Entry deleted', 'success');
            } else {
              showToast(`Couldn't delete: ${result.error}`, 'error');
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      {!online ? <OfflineBanner /> : null}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={isLoadingEntries && bootstrapped}
            onRefresh={refreshWeek}
            tintColor={colors.accent}
          />
        }
      >
        <View style={styles.header}>
          <Text style={styles.greeting}>{greetingFor(user)}</Text>
          <View style={styles.weekNavRow}>
            <Pressable
              accessibilityLabel="Previous week"
              onPress={() => setWeekOffset((o) => Math.max(-MAX_WEEK_OFFSET, o - 1))}
              disabled={weekOffset <= -MAX_WEEK_OFFSET}
              style={({ pressed }) => [
                styles.chev,
                pressed && styles.chevPressed,
                weekOffset <= -MAX_WEEK_OFFSET && styles.chevDisabled,
              ]}
            >
              <Ionicons name="chevron-back" size={18} color={colors.text} />
            </Pressable>
            <Text style={styles.subGreeting}>
              {weekRangeLabel(monday, friday, isPastWeek, isFutureWeek)}
            </Text>
            <Pressable
              accessibilityLabel="Next week"
              onPress={() => setWeekOffset((o) => Math.min(MAX_WEEK_OFFSET, o + 1))}
              disabled={weekOffset >= MAX_WEEK_OFFSET}
              style={({ pressed }) => [
                styles.chev,
                pressed && styles.chevPressed,
                weekOffset >= MAX_WEEK_OFFSET && styles.chevDisabled,
              ]}
            >
              <Ionicons name="chevron-forward" size={18} color={colors.text} />
            </Pressable>
            {!isCurrentWeek ? (
              <Pressable
                onPress={() => setWeekOffset(0)}
                style={({ pressed }) => [styles.todayPill, pressed && styles.todayPillPressed]}
              >
                <Text style={styles.todayPillText}>Today</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <WeekBar
          days={visibleDays}
          hoursByDay={hoursByDay}
          selectedDate={selectedDate}
          today={today}
          targetHours={targetPerDay}
          onSelectDay={setSelectedDate}
        />

        <View style={styles.summary}>
          <SummaryPill label="Logged" hours={totalHours} variant="accent" />
          <SummaryPill label="Remaining" hours={remaining} />
        </View>

        <View style={styles.projects}>
          <Text style={styles.sectionHeader}>Recent projects</Text>

          {isBootstrapping ? (
            <View style={styles.spinner}>
              <ActivityIndicator color={colors.accent} />
              {isSyncingFresh ? <Text style={styles.spinnerNote}>Syncing with BQE Core…</Text> : null}
            </View>
          ) : visibleProjects.length === 0 ? (
            <EmptyState
              icon="briefcase-outline"
              title="No active projects found"
              subtitle="Make sure you're assigned to projects in BQE Core."
            />
          ) : (
            <View style={styles.projectList}>
              {visibleProjects.map((node) => (
                <ProjectCard
                  key={node.project.id}
                  name={node.project.name}
                  phaseLabel={phaseLabelByParent.get(node.project.id) ?? null}
                  hours={hoursByParent.get(node.project.id) ?? 0}
                  color={node.project.color ?? colors.accent}
                  onPress={() => router.push(`/entry/${node.project.id}`)}
                />
              ))}
              {showMoreToggle ? (
                <Pressable
                  onPress={() => setShowAllProjects((v) => !v)}
                  style={({ pressed }) => [styles.moreBtn, pressed && styles.moreBtnPressed]}
                >
                  <Ionicons
                    name={showAllProjects ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={colors.muted}
                  />
                  <Text style={styles.moreBtnText}>
                    {showAllProjects
                      ? 'Hide other projects'
                      : `More projects (${moreProjectsCount})`}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}

          {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
        </View>

        {!isBootstrapping ? (
          <View style={styles.entries}>
            <View style={styles.entriesHeaderRow}>
              <Text style={styles.sectionHeader}>{entriesHeading(selectedDate, today)}</Text>
              {dayEntries.length > 0 ? (
                <Text style={styles.entriesCount}>
                  {dayEntries.length} entr{dayEntries.length === 1 ? 'y' : 'ies'}
                </Text>
              ) : null}
            </View>

            {dayEntries.length === 0 ? (
              <EmptyState
                icon="time-outline"
                title="No entries yet for this day"
                subtitle="Tap a project above or use the camera to scan a timesheet."
              />
            ) : (
              <View style={styles.entryList}>
                {dayEntries.map((entry) => {
                  const phase = projectsById.get(entry.projectId);
                  const parent = phase?.parentId
                    ? projectsById.get(phase.parentId)
                    : phase;
                  return (
                    <EntryRow
                      key={entry.id}
                      projectName={parent?.name ?? phase?.name ?? '(unknown)'}
                      phaseLabel={phase?.phaseCode ?? null}
                      hours={entry.hours}
                      memo={entry.memo}
                      color={parent?.color ?? colors.accent}
                      locked={!isEntryEditable(entry)}
                      pending={entry.syncStatus === 'pending'}
                      failed={entry.syncStatus === 'failed'}
                      submissionStatus={entry.submissionStatus}
                      onPress={() => handleEntryPress(entry)}
                      onDelete={() => handleEntryDelete(entry)}
                    />
                  );
                })}
              </View>
            )}
          </View>
        ) : null}

        {!isBootstrapping && weekEntries.length > 0 ? (
          <View style={styles.submitWrap}>
            <SubmitWeekCard
              draftHours={draftHours}
              draftCount={draftEntries.length}
              pendingCount={pendingWeekCount}
              submitting={isSubmittingWeek}
              onSubmit={handleSubmitWeek}
            />
          </View>
        ) : null}
      </ScrollView>

      <FloatingActionButton
        icon="camera-outline"
        accessibilityLabel="Scan timesheet"
        onPress={() => router.push('/scan')}
      />
    </SafeAreaView>
  );
}

function buildHoursByDay(entries: LocalTimeEntry[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const e of entries) {
    map[e.date] = (map[e.date] ?? 0) + e.hours;
  }
  return map;
}

function buildPhaseToParent(projects: LocalProject[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of projects) {
    if (p.isPhase && p.parentId) m.set(p.id, p.parentId);
  }
  return m;
}

function buildHoursByParent(
  entries: LocalTimeEntry[],
  phaseToParent: Map<string, string>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    const parentId = phaseToParent.get(e.projectId);
    if (!parentId) continue;
    m.set(parentId, (m.get(parentId) ?? 0) + e.hours);
  }
  return m;
}

function buildPhaseLabelByParent(
  entries: LocalTimeEntry[],
  flatProjects: LocalProject[],
  tree: ProjectNode[],
): Map<string, string | null> {
  const labels = new Map<string, string | null>();
  const projectsById = new Map(flatProjects.map((p) => [p.id, p]));
  const sortedEntries = [...entries].sort((a, b) => b.date.localeCompare(a.date));

  for (const node of tree) {
    const recent = sortedEntries.find((e) => projectsById.get(e.projectId)?.parentId === node.project.id);
    if (recent) {
      const phase = projectsById.get(recent.projectId);
      labels.set(node.project.id, phase?.phaseCode ?? phase?.name ?? null);
    } else {
      const firstPhase = node.phases[0];
      labels.set(node.project.id, firstPhase?.phaseCode ?? firstPhase?.name ?? null);
    }
  }
  return labels;
}

interface ProjectBuckets {
  withCurrent: ProjectNode[];
  withPrior: ProjectNode[];
  others: ProjectNode[];
}

function bucketProjects(
  tree: ProjectNode[],
  hoursByParent: Map<string, number>,
  priorWeekParentIds: Set<string>,
): ProjectBuckets {
  const withCurrent: ProjectNode[] = [];
  const withPrior: ProjectNode[] = [];
  const others: ProjectNode[] = [];
  for (const node of tree) {
    if ((hoursByParent.get(node.project.id) ?? 0) > 0) {
      withCurrent.push(node);
    } else if (priorWeekParentIds.has(node.project.id)) {
      withPrior.push(node);
    } else {
      others.push(node);
    }
  }
  const byName = (a: ProjectNode, b: ProjectNode) =>
    a.project.name.localeCompare(b.project.name);
  withCurrent.sort(byName);
  withPrior.sort(byName);
  others.sort(byName);
  return { withCurrent, withPrior, others };
}

function weekRangeLabel(
  monday: Date,
  friday: Date,
  isPast: boolean,
  isFuture: boolean,
): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const range = `${fmt(monday)} — ${fmt(friday)}`;
  if (isPast) return `Past week of ${range}`;
  if (isFuture) return `Future week of ${range}`;
  return `Week of ${range}`;
}

function greetingFor(user: { firstName?: string; displayName?: string } | null): string {
  if (!user) return 'Hi there';
  const first =
    user.firstName?.trim() ||
    user.displayName?.split(' ')[0]?.trim() ||
    null;
  return first ? `Hi, ${first}` : 'Hi there';
}

function entriesHeading(selectedDate: string, today: Date): string {
  if (selectedDate === toIsoDay(today)) return "Today's entries";
  const [y, m, d] = selectedDate.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString(undefined, { weekday: 'long' }) + "'s entries";
}

function displayNameForEntry(
  entry: LocalTimeEntry,
  projectsById: Map<string, LocalProject>,
): string {
  const phase = projectsById.get(entry.projectId);
  const parent = phase?.parentId ? projectsById.get(phase.parentId) : phase;
  return parent?.name ?? phase?.name ?? 'this entry';
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingTop: 8,
    paddingBottom: 120,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 8,
  },
  greeting: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.5,
  },
  weekNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  subGreeting: {
    flex: 1,
    fontSize: 14,
    color: colors.muted,
  },
  chev: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.subtle,
  },
  chevPressed: {
    opacity: 0.6,
  },
  chevDisabled: {
    opacity: 0.35,
  },
  todayPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  todayPillPressed: {
    opacity: 0.85,
  },
  todayPillText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  summary: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    marginTop: 16,
  },
  projects: {
    marginTop: 24,
    paddingHorizontal: 16,
    gap: 12,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  projectList: {
    gap: 10,
  },
  moreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  moreBtnPressed: {
    opacity: 0.7,
  },
  moreBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  entries: {
    marginTop: 28,
    paddingHorizontal: 16,
    gap: 12,
  },
  entriesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  entriesCount: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
  },
  entryList: {
    gap: 10,
  },
  submitWrap: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  spinner: {
    paddingVertical: 32,
    alignItems: 'center',
    gap: 8,
  },
  spinnerNote: {
    fontSize: 13,
    color: colors.muted,
  },
  error: {
    fontSize: 13,
    color: colors.danger,
    paddingHorizontal: 4,
  },
});
