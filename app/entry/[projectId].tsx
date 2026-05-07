import { useEffect, useMemo } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { colors } from '../../theme';
import { DaySelector } from '../../components/DaySelector';
import { PhaseButton } from '../../components/PhaseButton';
import { EmptyState } from '../../components/EmptyState';
import { useProjectStore } from '../../store/useProjectStore';
import { useEntryStore } from '../../store/useEntryStore';
import { phaseMeta } from '../../utils/phaseMeta';
import { getMonday, getWeekDays } from '../../utils/dateHelpers';

const WEEKDAYS = 5;

export default function PhaseSelectionScreen() {
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();

  const today = useMemo(() => new Date(), []);
  const monday = useMemo(() => getMonday(today), [today]);
  const visibleDays = useMemo(() => getWeekDays(monday, WEEKDAYS), [monday]);

  const flatProjects = useProjectStore((s) => s.flatProjects);
  const isLoadingProjects = useProjectStore((s) => s.isLoading);
  const selectedDate = useEntryStore((s) => s.selectedDate);
  const setSelectedDate = useEntryStore((s) => s.setSelectedDate);

  const project = useMemo(
    () => flatProjects.find((p) => p.id === projectId && !p.isPhase) ?? null,
    [flatProjects, projectId],
  );
  const phases = useMemo(
    () => flatProjects.filter((p) => p.isPhase && p.parentId === projectId),
    [flatProjects, projectId],
  );

  const projectsLoaded = flatProjects.length > 0;

  useEffect(() => {
    if (!projectsLoaded || !projectId) return;
    if (phases.length === 1) {
      router.replace({ pathname: '/entry/hours', params: { projectId: phases[0].id } });
    } else if (phases.length === 0 && project) {
      router.replace({ pathname: '/entry/hours', params: { projectId: project.id } });
    }
  }, [projectsLoaded, projectId, phases, project, router]);

  const onPickPhase = (phaseId: string) => {
    router.push({ pathname: '/entry/hours', params: { projectId: phaseId } });
  };

  const headerTitle = project?.name ?? 'Project';

  if (!projectsLoaded || isLoadingProjects) {
    return (
      <View style={styles.center}>
        <Stack.Screen
          options={{
            title: headerTitle,
            headerBackTitle: '',
            headerBackButtonDisplayMode: 'minimal',
          }}
        />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!project) {
    return (
      <View style={styles.center}>
        <Stack.Screen
          options={{
            title: 'Project',
            headerBackTitle: '',
            headerBackButtonDisplayMode: 'minimal',
          }}
        />
        <EmptyState
          icon="alert-circle-outline"
          title="Project not found"
          subtitle="It may have been deactivated in BQE Core."
        />
      </View>
    );
  }

  if (phases.length <= 1) {
    return (
      <View style={styles.center}>
        <Stack.Screen
          options={{
            title: headerTitle,
            headerBackTitle: '',
            headerBackButtonDisplayMode: 'minimal',
          }}
        />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />

      <DaySelector
        days={visibleDays}
        selectedDate={selectedDate}
        today={today}
        onSelectDay={setSelectedDate}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.grid}>
          {phases.map((phase) => {
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
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 32,
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
