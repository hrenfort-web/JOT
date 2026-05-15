import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { colors } from '../../theme';
import { WeekBar } from '../../components/WeekBar';
import { HeaderHomeButton } from '../../components/HeaderHomeButton';
import { PhaseButton } from '../../components/PhaseButton';
import { PhaseList, type PhaseGroup } from '../../components/PhaseList';
import { EmptyState } from '../../components/EmptyState';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { useAuthStore } from '../../store/useAuthStore';
import { phaseMeta } from '../../utils/phaseMeta';
import { getMonday, getWeekDays } from '../../utils/dateHelpers';
import { loadLastUsedDateByPhase } from '../../services/bqe/timeentry';
import type { LocalProject } from '../../db/schema';

const WEEKDAYS = 5;

// View-mode thresholds. Tweak both numbers together: GRID_MAX is inclusive
// (≤ 6 phases stays in the grid), LIST_SEARCH_MIN is the inclusive lower
// bound for showing the search bar.
const GRID_MAX = 6;
const LIST_SEARCH_MIN = 12;
const RECENCY_WINDOW_DAYS = 90;

// Stable module-scope reference for the header-right slot — prevents
// inline arrow churn on every render. See app/_layout.tsx and
// app/entry/hours.tsx for the broader hoisting rationale.
const renderHeaderHomeButton = () => <HeaderHomeButton />;

// Static options block used by the project-not-found early return.
// Title is the literal 'Project', so this is fully hoistable.
const PROJECT_NOT_FOUND_OPTIONS = {
  title: 'Project',
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
  headerRight: renderHeaderHomeButton,
};

// Stable parts shared by the three other emit sites — title is dynamic
// (`headerTitle`) so the final options object is composed via useMemo
// inside the component.
const PICKER_SCREEN_OPTIONS_BASE = {
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
  headerRight: renderHeaderHomeButton,
};

interface SortedPhases {
  recent: LocalProject[];
  other: LocalProject[];
}

function sortPhases(
  phases: LocalProject[],
  lastUsed: Map<string, string>,
): SortedPhases {
  const recent: LocalProject[] = [];
  const other: LocalProject[] = [];
  for (const phase of phases) {
    if (lastUsed.has(phase.id)) {
      recent.push(phase);
    } else {
      other.push(phase);
    }
  }
  // Most recently used first.
  recent.sort((a, b) => {
    const da = lastUsed.get(a.id) ?? '';
    const db = lastUsed.get(b.id) ?? '';
    return db.localeCompare(da);
  });
  // Alphabetical by phase code, then name, for the unused tail.
  other.sort((a, b) => {
    const ca = a.phaseCode ?? '';
    const cb = b.phaseCode ?? '';
    if (ca !== cb) return ca.localeCompare(cb);
    return a.name.localeCompare(b.name);
  });
  return { recent, other };
}

function matchesSearch(phase: LocalProject, query: string): boolean {
  if (!query) return true;
  const meta = phaseMeta(phase.phaseCode, phase.name);
  const haystack = `${meta.code} ${meta.name} ${phase.name}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export default function PhaseSelectionScreen() {
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();

  const today = useMemo(() => new Date(), []);
  const monday = useMemo(() => getMonday(today), [today]);
  const visibleDays = useMemo(() => getWeekDays(monday, WEEKDAYS), [monday]);

  const flatProjects = useProjectStore((s) => s.flatProjects);
  const getProjectPhases = useProjectStore((s) => s.getProjectPhases);
  const isLoadingProjects = useProjectStore((s) => s.isLoading);
  const selectedDate = useEntryStore((s) => s.selectedDate);
  const setSelectedDate = useEntryStore((s) => s.setSelectedDate);
  const resourceId = useAuthStore((s) => s.user?.id ?? null);

  const project = useMemo(
    () => flatProjects.find((p) => p.id === projectId && !p.isPhase) ?? null,
    [flatProjects, projectId],
  );
  // Filtered to allowed contract types (Studio G excludes Reimbursable +
  // Cost+Percentage). Disallowed phases never appear in the picker.
  const phases = useMemo(
    () => (projectId ? getProjectPhases(projectId) : []),
    [getProjectPhases, flatProjects, projectId],
  );

  const projectsLoaded = flatProjects.length > 0;

  const [lastUsed, setLastUsed] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState('');

  // Pull recency once per project visit. We don't subscribe to entry-store
  // changes here — the picker is short-lived and re-mounts on each navigation.
  useEffect(() => {
    let cancelled = false;
    if (!resourceId || phases.length < 2) {
      setLastUsed(new Map());
      return;
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RECENCY_WINDOW_DAYS);
    loadLastUsedDateByPhase(
      resourceId,
      phases.map((p) => p.id),
      cutoff,
    )
      .then((map) => {
        if (!cancelled) setLastUsed(map);
      })
      .catch(() => {
        if (!cancelled) setLastUsed(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [resourceId, phases]);

  useEffect(() => {
    if (!projectsLoaded || !projectId) return;
    if (phases.length === 1) {
      router.replace({ pathname: '/entry/hours', params: { projectId: phases[0].id } });
    } else if (phases.length === 0 && project) {
      router.replace({ pathname: '/entry/hours', params: { projectId: project.id } });
    }
  }, [projectsLoaded, projectId, phases, project, router]);

  const sorted = useMemo(() => sortPhases(phases, lastUsed), [phases, lastUsed]);
  const orderedPhases = useMemo(
    () => [...sorted.recent, ...sorted.other],
    [sorted],
  );

  // Decide rendering mode by phase count.
  const phaseCount = phases.length;
  const useGrid = phaseCount <= GRID_MAX;
  const useSearch = phaseCount >= LIST_SEARCH_MIN;

  // Build groups for the list view. Skip dual headers when one bucket is
  // empty (e.g. brand-new project with no entries yet, or every phase used
  // recently) — a single ungrouped section reads cleaner than a lone header.
  // Computed unconditionally to keep hook order stable across early returns.
  const groups: PhaseGroup[] = useMemo(() => {
    if (useGrid) return [];
    const filterFn = (p: LocalProject) => matchesSearch(p, search);
    const recent = sorted.recent.filter(filterFn);
    const other = sorted.other.filter(filterFn);
    const bothPopulated = recent.length > 0 && other.length > 0;
    if (!bothPopulated) {
      return [{ title: null, phases: [...recent, ...other] }];
    }
    return [
      { title: 'Recently used', phases: recent },
      { title: 'Other phases', phases: other },
    ];
  }, [useGrid, sorted, search]);

  const onPickPhase = (phaseId: string) => {
    router.push({ pathname: '/entry/hours', params: { projectId: phaseId } });
  };

  const headerTitle = project?.name ?? 'Project';
  // Memoised options object shared across the three emit sites that use
  // `headerTitle` (loading state, single-phase state, main render).
  // Only re-derives when the title string actually changes.
  const pickerScreenOptions = useMemo(
    () => ({ ...PICKER_SCREEN_OPTIONS_BASE, title: headerTitle }),
    [headerTitle],
  );

  if (!projectsLoaded || isLoadingProjects) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={pickerScreenOptions} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!project) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={PROJECT_NOT_FOUND_OPTIONS} />
        <EmptyState
          icon="alert-circle-outline"
          title="Project not found"
          subtitle="It may have been deactivated."
        />
      </View>
    );
  }

  if (phases.length <= 1) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={pickerScreenOptions} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={pickerScreenOptions} />

      {/*
        Compact WeekBar — same chrome as the home screen pills, minus
        the per-day hours total. The entry flow doesn't surface weekly
        totals so the pill only carries the day letter; today still
        gets the accent border + accent letter treatment.
      */}
      <View style={styles.daySelectorWrap}>
        <WeekBar
          days={visibleDays}
          selectedDate={selectedDate}
          today={today}
          onSelectDay={setSelectedDate}
        />
      </View>

      <ScrollView
        contentContainerStyle={useGrid ? styles.scroll : styles.scrollList}
        keyboardShouldPersistTaps="handled"
      >
        {useGrid ? (
          <View style={styles.grid}>
            {orderedPhases.map((phase) => {
              const meta = phaseMeta(phase.phaseCode, phase.name);
              return (
                <View key={phase.id} style={styles.cell}>
                  <PhaseButton
                    code={meta.code}
                    name={meta.name}
                    icon={meta.icon}
                    onPress={() => onPickPhase(phase.id)}
                  />
                </View>
              );
            })}
          </View>
        ) : (
          <PhaseList
            groups={groups}
            onPickPhase={onPickPhase}
            searchEnabled={useSearch}
            searchValue={search}
            onChangeSearch={setSearch}
          />
        )}
      </ScrollView>
    </View>
  );
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
  daySelectorWrap: {
    // Vertical breathing room around the week strip. The strip itself
    // owns its horizontal padding, so we only add vertical here.
    paddingVertical: 12,
  },
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  scrollList: {
    paddingTop: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  cell: {
    width: '48%',
  },
});
