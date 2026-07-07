import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { fromIsoDay, getMonday, getWeekDays } from '../../utils/dateHelpers';
import { useToday } from '../../hooks/useToday';
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

  const flatProjects = useProjectStore((s) => s.flatProjects);
  const getProjectPhases = useProjectStore((s) => s.getProjectPhases);
  const isLoadingProjects = useProjectStore((s) => s.isLoading);
  const selectedDate = useEntryStore((s) => s.selectedDate);
  const setSelectedDate = useEntryStore((s) => s.setSelectedDate);
  const resourceId = useAuthStore((s) => s.user?.id ?? null);

  // `today` is the device's actual today — fed to WeekBar's `today` prop
  // ONLY for the today-marker (accent day letter). It does NOT drive the
  // visible week (that derives from selectedDate). Live via useToday so the
  // marker stays correct across an overnight background-resume (audit H-1).
  const today = useToday();

  // Visible week is derived from selectedDate so a past-week selection on
  // home carries through. Defensive parse: empty/malformed/stale
  // selectedDate falls back to today so the screen never crashes.
  // fromIsoDay uses the local-time Date constructor (`new Date(y, m-1, d)`),
  // so the parse is timezone-safe.
  const parsedSelectedDate = useMemo(() => {
    if (selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      const d = fromIsoDay(selectedDate);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }, [selectedDate]);
  const monday = useMemo(() => getMonday(parsedSelectedDate), [parsedSelectedDate]);
  const visibleDays = useMemo(() => getWeekDays(monday, WEEKDAYS), [monday]);

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
        totals so the pill only carries the day letter. Today (when not
        selected) keeps the accent day letter; the SELECTED day owns
        the border — exactly one pill is bordered at a time.
      */}
      <View style={styles.daySelectorWrap}>
        <WeekBar
          days={visibleDays}
          selectedDate={selectedDate}
          today={today}
          onSelectDay={setSelectedDate}
        />
        {/*
          Unambiguous full-date callout under the WeekBar. The compact
          day letters read identically across weeks; this label tells the
          user e.g. "Thursday, May 22" so a past-week selection can't be
          mistaken for the current week.
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
  // Subtle secondary-color full-date label sitting directly under the
  // WeekBar. Centered to anchor under the day-letter row.
  dateLabel: {
    marginTop: 8,
    textAlign: 'center',
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
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
