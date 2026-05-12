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
import { colors, FONT_HANDWRITING } from '../../theme';
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
  loadLocalEntriesInRange,
  lockReasonMessage,
} from '../../services/bqe/timeentry';
import {
  DEFAULT_RECENT_DAYS,
  recentProjectParentIds,
  sortProjectsForPicker,
} from '../../utils/projectSort';
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
  // 90-day entry window for the picker sort. Loaded once on bootstrap and
  // refreshed whenever the user navigates back to the home screen so a
  // brand-new entry shifts that project to the top of tier 1 immediately.
  const [recentEntries, setRecentEntries] = useState<LocalTimeEntry[]>([]);

  const standardHours = (user?.standardHoursPerWeek as number | undefined) ?? 40;

  const refreshWeek = useCallback(async () => {
    if (!user?.id) return;
    await loadWeek(user.id, toIsoDay(monday), toIsoDay(sunday));
  }, [user?.id, loadWeek, monday, sunday]);

  useEffect(() => {
    if (!user?.id || bootstrapped) return;
    let cancelled = false;
    (async () => {
      const t0 = Date.now();
      if (__DEV__) console.log('[jot:home] bootstrap START');
      setIsBootstrapping(true);
      try {
        await refreshProjects();
        if (__DEV__) {
          console.log(
            `[jot:home] post-refresh project count = ${useProjectStore.getState().flatProjects.length}`,
          );
        }
        if (useProjectStore.getState().flatProjects.length === 0) {
          if (__DEV__) console.log('[jot:home] cache empty — running initialSync');
          setIsSyncingFresh(true);
          try {
            await runInitialSync();
          } finally {
            setIsSyncingFresh(false);
          }
          await refreshProjects();
        }
        await refreshWeek();
      } catch (e) {
        if (__DEV__) console.log('[jot:home] bootstrap FAILED:', e);
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
          setBootstrapped(true);
          if (__DEV__) {
            console.log(`[jot:home] bootstrap COMPLETE in ${Date.now() - t0}ms`);
          }
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

  // Load the 90-day entry window that drives the picker sort. Re-runs when
  // the user changes or the project cache size changes (which fires after
  // every initialSync). Falls back to an empty array on error — the sort
  // gracefully degrades to tier-2-only ordering (project number desc).
  useEffect(() => {
    if (!user?.id) return;
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - DEFAULT_RECENT_DAYS);
    let cancelled = false;
    loadLocalEntriesInRange(user.id, start, end)
      .then((entries) => {
        if (!cancelled) setRecentEntries(entries);
      })
      .catch(() => {
        if (!cancelled) setRecentEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, flatProjects.length, weekEntries.length]);

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

  // Cap renders so a firm with thousands of active projects doesn't try to
  // mount 3,000+ Pressables at once (Studio G's BQE returns 3,226 projects).
  // Past ~500 we hide the "More projects" expander entirely — the FAB →
  // picker route lets the user search the full set when needed.
  const HEAVY_LIST_THRESHOLD = 500;
  const isHeavyList = flatProjects.length > HEAVY_LIST_THRESHOLD;

  // Picker sort: tier 1 = parents the user logged time against in the last
  // 90 days, most-recent first; tier 2 = everything else by parsed project
  // number desc (year desc, then NNN desc). See utils/projectSort.ts.
  //
  // The home screen renders tier 1 unconditionally and parks tier 2 behind
  // the "More projects" expander — same UX as the prior bucket model,
  // different ordering inside each bucket.
  const sortedProjectNodes = useMemo(() => {
    if (!user?.id || tree.length === 0) return [] as ProjectNode[];
    const sorted = sortProjectsForPicker(flatProjects, recentEntries, user.id);
    const nodesById = new Map<string, ProjectNode>();
    for (const node of tree) nodesById.set(node.project.id, node);
    const out: ProjectNode[] = [];
    for (const project of sorted) {
      const node = nodesById.get(project.id);
      if (node) out.push(node);
    }
    return out;
  }, [user?.id, tree, flatProjects, recentEntries]);

  const recentParentSet = useMemo(() => {
    if (!user?.id) return new Set<string>();
    return recentProjectParentIds(flatProjects, recentEntries, user.id);
  }, [user?.id, flatProjects, recentEntries]);

  const visibleProjects = useMemo(() => {
    const tier1 = sortedProjectNodes.filter((n) => recentParentSet.has(n.project.id));
    const tier2 = sortedProjectNodes.filter((n) => !recentParentSet.has(n.project.id));
    if (showAllProjects && !isHeavyList) {
      return [...tier1, ...tier2];
    }
    return tier1;
  }, [sortedProjectNodes, recentParentSet, showAllProjects, isHeavyList]);
  const moreProjectsCount = sortedProjectNodes.length - recentParentSet.size;
  const showMoreToggle =
    !isHeavyList &&
    moreProjectsCount > 0 &&
    recentParentSet.size > 0;
  const noRecentActivity = tree.length > 0 && recentParentSet.size === 0;

  if (__DEV__) {
    console.log(
      `[jot:home] flatProjects=${flatProjects.length} recentParents=${recentParentSet.size} sorted=${sortedProjectNodes.length} visible=${visibleProjects.length} heavyList=${isHeavyList}`,
    );
  }

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
              accessibilityRole="button"
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
              accessibilityRole="button"
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
                accessibilityRole="button"
                accessibilityLabel="Jump to current week"
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
          ) : tree.length === 0 ? (
            <EmptyState
              icon="briefcase-outline"
              title="No active projects found"
              subtitle="Make sure you're assigned to projects in BQE Core."
            />
          ) : noRecentActivity ? (
            // Honest empty state: don't fake a list out of the alphabetical
            // first N projects. The + FAB is the route to the full picker.
            // The "More projects" expander is intentionally suppressed here
            // for the same reason — pretending the user has a relevant list
            // when they haven't logged anything is misleading.
            <EmptyState
              icon="calendar-outline"
              title="No recent activity"
              subtitle="Tap + below to log your first entry. Projects you charge to will appear here."
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
                    color={colors.textSecondary}
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

          {/* Persistent CTA — visible whether the user has 0 entries or a
              full week logged. Unconditional so users always have a clear
              path to the picker without hunting for the FAB. Uses the same
              styling as the prior empty-state-only button. */}
          {!isBootstrapping ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log your time"
              onPress={() => router.push('/entry/picker')}
              style={({ pressed }) => [
                styles.firstEntryBtn,
                pressed && styles.firstEntryBtnPressed,
              ]}
            >
              <Text style={styles.firstEntryBtnText}>Log your time</Text>
            </Pressable>
          ) : null}
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
        icon="add"
        label="Log time"
        accessibilityLabel="Log time on a new project"
        onPress={() => router.push('/entry/picker')}
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
  // Theme B greeting: Architects Daughter at 32px. The handwritten tone
  // greets the user — the rest of the home page is typeset prose. Negative
  // letter-spacing that worked for system sans is dropped here; the
  // handwriting font has its own natural spacing and tightening warps it.
  greeting: {
    fontFamily: FONT_HANDWRITING,
    fontSize: 32,
    lineHeight: 36,
    color: colors.text,
  },
  weekNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  subGreeting: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
  },
  chev: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    // Cream surface tile (vs the subtle peach the prior palette used).
    // Pairs with the rest of the page's "lifted cream" surfaces.
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  chevPressed: {
    opacity: 0.6,
  },
  chevDisabled: {
    opacity: 0.35,
  },
  // "Today" jump-to pill — when the user is viewing a past/future week,
  // this offers a one-tap shortcut back. Theme B: accentTint background +
  // accent label, NOT a solid accent fill with white text. The week-nav
  // row is supporting chrome, not a CTA — the muted treatment keeps it
  // from competing with the +Log time FAB.
  todayPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.accentTint,
  },
  todayPillPressed: {
    opacity: 0.75,
  },
  todayPillText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '500',
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
  // Theme B section header: sentence case (e.g. "Recent projects"), 13px,
  // textSecondary, weight 500. The prior uppercase + 0.6 letter-spacing
  // treatment was chrome-noise — collapsed to a quiet caption.
  sectionHeader: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    letterSpacing: 0.2,
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
  // Theme B "Log Your Time" CTA. Previously a solid accent pill; now a
  // dashed cream card. The +Log time FAB is the primary action and uses
  // the solid-accent treatment — having two solid-accent CTAs side-by-side
  // would split the user's eye. Dashed border signals "tap to create"
  // without competing for visual weight.
  firstEntryBtn: {
    alignSelf: 'center',
    marginTop: 4,
    marginHorizontal: 24,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    minWidth: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  firstEntryBtnPressed: {
    backgroundColor: colors.subtle,
  },
  firstEntryBtnText: {
    // Primary text, NOT accent. The FAB directly below this card already
    // carries the orange CTA weight — two equally-orange CTAs read as two
    // primary actions and split the user's eye. The dashed cream border
    // does the "this is tappable" work; the label is just the label.
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  moreBtnPressed: {
    opacity: 0.7,
  },
  moreBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
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
    fontWeight: '500',
    color: colors.textTertiary,
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
    color: colors.textSecondary,
  },
  error: {
    fontSize: 13,
    color: colors.danger,
    paddingHorizontal: 4,
  },
});
