import { memo, useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme';
import { EmptyState } from '../../components/EmptyState';
import { useProjectStore } from '../../store/useProjectStore';
import type { ProjectNode } from '../../services/bqe/project';

// Studio G's tenant returns 3,226 active projects. ScrollView mounted every
// row up-front, which made first-open of the picker unusably sluggish.
// FlatList virtualizes — only ~window-size rows are mounted at any time.

interface PickerRowProps {
  node: ProjectNode;
  onPick: (projectId: string) => void;
}

// Memoized so virtualization can actually skip re-renders. `onPick` is
// stable (useCallback in the parent), so referential equality holds even
// when the parent re-renders due to search input changes.
const PickerRow = memo(function PickerRow({ node, onPick }: PickerRowProps) {
  const project = node.project;
  const handlePress = useCallback(() => onPick(project.id), [onPick, project.id]);
  const sub = project.clientName ?? project.code ?? null;
  const phaseSummary =
    node.phases.length > 0
      ? `, ${node.phases.length} phase${node.phases.length === 1 ? '' : 's'}`
      : '';
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${project.name}${sub ? `, ${sub}` : ''}${phaseSummary}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View
        style={[
          styles.dot,
          { backgroundColor: project.color ?? colors.accent },
        ]}
      />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {project.name}
        </Text>
        {sub ? (
          <Text style={styles.client} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
});

export default function PickerScreen() {
  const router = useRouter();
  const tree = useProjectStore((s) => s.tree);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tree;
    return tree.filter((node) => {
      const project = node.project;
      return (
        project.name.toLowerCase().includes(q) ||
        (project.clientName ?? '').toLowerCase().includes(q) ||
        (project.code ?? '').toLowerCase().includes(q)
      );
    });
  }, [tree, query]);

  const handlePick = useCallback(
    (projectId: string) => {
      router.push(`/entry/${projectId}`);
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ProjectNode>) => (
      <PickerRow node={item} onPick={handlePick} />
    ),
    [handlePick],
  );

  const keyExtractor = useCallback((node: ProjectNode) => node.project.id, []);

  // Header is the search bar. Lives inside the FlatList so it scrolls with
  // the list — matches the iOS Settings/Contacts pattern. If we ever want a
  // sticky search instead, hoist this back out as a SafeAreaView sibling.
  const ListHeader = useMemo(
    () => (
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects, clients, codes…"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {query.length > 0 ? (
          <Pressable
            onPress={() => setQuery('')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Ionicons name="close-circle" size={16} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
    ),
    [query],
  );

  const ListEmpty = useMemo(
    () => (
      <EmptyState
        icon="search-outline"
        title={tree.length === 0 ? 'No projects yet' : 'No matches'}
        subtitle={
          tree.length === 0
            ? 'Sync with BQE Core or use Demo Mode to load sample projects.'
            : 'Try a shorter search or check the spelling.'
        }
      />
    ),
    [tree.length],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen
        options={{
          title: 'Pick a project',
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />

      <FlatList
        data={filtered}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.list}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmpty}
        ItemSeparatorComponent={Separator}
        keyboardShouldPersistTaps="handled"
        // Virtualization knobs tuned for the 3,226-row Studio G tenant.
        // initialNumToRender mounts 20 rows on first paint (1.5 screens
        // worth on most phones); windowSize keeps ~10 screens of cells in
        // memory; removeClippedSubviews offloads off-screen nodes from the
        // native view hierarchy on Android (no-op on iOS but harmless).
        initialNumToRender={20}
        windowSize={10}
        removeClippedSubviews
        // No getItemLayout: ListHeaderComponent height is dynamic (the
        // search bar grows when an error message is added later, etc.) and
        // accounting for it in the offset math is brittle. Virtualization
        // alone solves the perf problem; getItemLayout is a microoptimisation
        // we can revisit if scrollToIndex jumps ever feel laggy.
      />
    </SafeAreaView>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 0,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.subtle,
    borderRadius: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
    paddingVertical: 0,
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 32,
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  rowPressed: {
    backgroundColor: colors.subtle,
  },
  separator: {
    height: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  client: {
    fontSize: 12,
    color: colors.muted,
  },
});
