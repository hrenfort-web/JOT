import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { colors } from '../../theme';
import {
  formatHours,
  getMonday,
  getSunday,
  getWeekDays,
  toIsoDay,
} from '../../utils/dateHelpers';
import { WeekBar } from '../../components/WeekBar';
import { SummaryPill } from '../../components/SummaryPill';
import { ProjectCard } from '../../components/ProjectCard';
import { EntryRow } from '../../components/EntryRow';
import { FloatingActionButton } from '../../components/FloatingActionButton';
import { EmptyState } from '../../components/EmptyState';
import { OfflineBanner } from '../../components/OfflineBanner';
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { useToastStore } from '../../store/useToastStore';
import { runInitialSync } from '../../services/sync/initialSync';
import { isEntryLocked } from '../../services/bqe/timeentry';
import { useOnline } from '../../services/sync/connectivity';
import type { LocalProject, LocalTimeEntry } from '../../db/schema';
import type { ProjectNode } from '../../services/bqe/project';

const WEEKDAYS = 5;

export default function HomeScreen() {
  const router = useRouter();
  const today = useMemo(() => new Date(), []);
  const monday = useMemo(() => getMonday(today), [today]);
  const sunday = useMemo(() => getSunday(today), [today]);
  const visibleDays = useMemo(() => getWeekDays(monday, WEEKDAYS), [monday]);

  const user = useAuthStore((s) => s.user);

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
  const showToast = useToastStore((s) => s.show);
  const online = useOnline();

  const [bootstrapped, setBootstrapped] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSyncingFresh, setIsSyncingFresh] = useState(false);

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

  const sortedProjects = useMemo(() => sortProjects(tree, hoursByParent), [tree, hoursByParent]);

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

  const handleEntryPress = (entry: LocalTimeEntry) => {
    if (isEntryLocked(entry)) {
      showToast('This entry is locked because it has been billed', 'info');
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
    if (isEntryLocked(entry)) return;
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
          <Text style={styles.greeting}>This week</Text>
          <Text style={styles.subGreeting}>{formatWeekRange(monday, sunday)}</Text>
        </View>

        <WeekBar
          days={visibleDays}
          hoursByDay={hoursByDay}
          selectedDate={selectedDate}
          today={today}
          onSelectDay={setSelectedDate}
        />

        <View style={styles.summary}>
          <SummaryPill label="Logged" hours={totalHours} variant="accent" />
          <SummaryPill label="Remaining" hours={remaining} />
        </View>

        <View style={styles.projects}>
          <Text style={styles.sectionHeader}>Your projects</Text>

          {isBootstrapping ? (
            <View style={styles.spinner}>
              <ActivityIndicator color={colors.accent} />
              {isSyncingFresh ? <Text style={styles.spinnerNote}>Syncing with BQE Core…</Text> : null}
            </View>
          ) : sortedProjects.length === 0 ? (
            <EmptyState
              icon="briefcase-outline"
              title="No active projects found"
              subtitle="Make sure you're assigned to projects in BQE Core."
            />
          ) : (
            <View style={styles.projectList}>
              {sortedProjects.map((node) => (
                <ProjectCard
                  key={node.project.id}
                  name={node.project.name}
                  phaseLabel={phaseLabelByParent.get(node.project.id) ?? null}
                  hours={hoursByParent.get(node.project.id) ?? 0}
                  color={node.project.color ?? colors.accent}
                  onPress={() => router.push(`/entry/${node.project.id}`)}
                />
              ))}
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
                      locked={isEntryLocked(entry)}
                      pending={entry.syncStatus === 'pending'}
                      failed={entry.syncStatus === 'failed'}
                      onPress={() => handleEntryPress(entry)}
                      onDelete={() => handleEntryDelete(entry)}
                    />
                  );
                })}
              </View>
            )}
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

function sortProjects(
  tree: ProjectNode[],
  hoursByParent: Map<string, number>,
): ProjectNode[] {
  const withHours: ProjectNode[] = [];
  const without: ProjectNode[] = [];
  for (const node of tree) {
    if ((hoursByParent.get(node.project.id) ?? 0) > 0) {
      withHours.push(node);
    } else {
      without.push(node);
    }
  }
  withHours.sort((a, b) => a.project.name.localeCompare(b.project.name));
  without.sort((a, b) => a.project.name.localeCompare(b.project.name));
  return [...withHours, ...without];
}

function formatWeekRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
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
    gap: 2,
  },
  greeting: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.5,
  },
  subGreeting: {
    fontSize: 14,
    color: colors.muted,
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
