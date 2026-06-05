import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Keyboard,
  ListRenderItemInfo,
  Platform,
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
import { useAuthStore } from '../../store/useAuthStore';
import { loadLocalEntriesInRange } from '../../services/bqe/timeentry';
import {
  DEFAULT_RECENT_DAYS,
  recentProjectParentIds,
  sortProjectsForPicker,
} from '../../utils/projectSort';
import type { ProjectNode } from '../../services/bqe/project';
import type { LocalTimeEntry } from '../../db/schema';

// Studio G's tenant returns 3,226 active projects. ScrollView mounted every
// row up-front, which made first-open of the picker unusably sluggish.
// FlatList virtualizes — only ~window-size rows are mounted at any time.

// Single discriminated row type so the FlatList can carry both section
// headers ("Recent" / "All projects") and project rows in one virtualized
// list. Using a SectionList would force two parallel sections-arrays and
// re-derive section indexes for every search-mode collapse — flat FlatList
// with discriminated rows is simpler and preserves the existing
// virtualization tuning.
type PickerListRow =
  | { kind: 'project'; node: ProjectNode }
  | { kind: 'header'; id: string; label: string; count: number };

// Hoisted so the contentContainerStyle override below can compose
// `LIST_PADDING_BOTTOM + keyboardPadding` without reading from the compiled
// StyleSheet object (opaque in production builds).
const LIST_PADDING_BOTTOM = 32;

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
  const flatProjects = useProjectStore((s) => s.flatProjects);
  const user = useAuthStore((s) => s.user);
  const [query, setQuery] = useState('');
  // 90-day window of the user's entries — fed into both the recency sort
  // and the partition. Loader effect below mirrors app/(tabs)/index.tsx
  // (the home tab's same loader) minus the weekEntries dependency, which
  // doesn't apply here — the picker doesn't react to visible-week edits.
  const [recentEntries, setRecentEntries] = useState<LocalTimeEntry[]>([]);
  // Android-only: tracks the keyboard height so we can pad the bottom of
  // the list and stop the keyboard from burying the last few results. iOS
  // gets the equivalent via automaticallyAdjustKeyboardInsets on the
  // FlatList, so this state stays at 0 on iOS.
  const [keyboardPadding, setKeyboardPadding] = useState(0);

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
  }, [user?.id, flatProjects.length]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardPadding(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardPadding(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Tier 1 (recent, by most-recent-entry desc) + Tier 2 (all other active
  // parents by parsed project number desc). sortProjectsForPicker is the
  // canonical recency sort used by the home tab — it returns the FULL set
  // of active top-level parents, sorted; recency partitions only the
  // order, never excludes anything. Same id→ProjectNode map pattern as
  // app/(tabs)/index.tsx so phases stay attached for the next screen.
  const sortedProjectNodes = useMemo<ProjectNode[]>(() => {
    if (!user?.id || tree.length === 0) return [];
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

  // Membership set for the section split. Sort order is already handled
  // by sortProjectsForPicker; this just decides which header a node sits
  // under in browse mode.
  const recentParentSet = useMemo(() => {
    if (!user?.id) return new Set<string>();
    return recentProjectParentIds(flatProjects, recentEntries, user.id);
  }, [user?.id, flatProjects, recentEntries]);

  // Browse mode: partition into Recent / All sections, each with a header
  // row. Search mode: collapse to a single flat list of matches, no
  // headers (section labels stop being meaningful during search). Search
  // walks `sortedProjectNodes` (not raw `tree`) so results stay recency-
  // ranked. Match logic preserved from the prior `filtered` useMemo.
  const rows = useMemo<PickerListRow[]>(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const matches: PickerListRow[] = [];
      for (const node of sortedProjectNodes) {
        const project = node.project;
        if (
          project.name.toLowerCase().includes(q) ||
          (project.clientName ?? '').toLowerCase().includes(q) ||
          (project.code ?? '').toLowerCase().includes(q)
        ) {
          matches.push({ kind: 'project', node });
        }
      }
      return matches;
    }
    const recentNodes: ProjectNode[] = [];
    const otherNodes: ProjectNode[] = [];
    // sortedProjectNodes only ever holds top-level parents (sortProjectsForPicker
    // filters to `parentId == null` before sorting), so `parentId ?? id`
    // reduces to `id` today — but it mirrors how recentProjectParentIds
    // keys the Set (utils/projectSort.ts:85), so the lookup stays correct
    // if the picker's contents ever broaden.
    for (const node of sortedProjectNodes) {
      const lookupId = node.project.parentId ?? node.project.id;
      if (recentParentSet.has(lookupId)) recentNodes.push(node);
      else otherNodes.push(node);
    }
    const out: PickerListRow[] = [];
    if (recentNodes.length > 0) {
      out.push({ kind: 'header', id: 'recent', label: 'Recent', count: recentNodes.length });
      for (const node of recentNodes) out.push({ kind: 'project', node });
    }
    if (otherNodes.length > 0) {
      out.push({ kind: 'header', id: 'all', label: 'All projects', count: otherNodes.length });
      for (const node of otherNodes) out.push({ kind: 'project', node });
    }
    return out;
  }, [query, sortedProjectNodes, recentParentSet]);

  const handlePick = useCallback(
    (projectId: string) => {
      router.push(`/entry/${projectId}`);
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<PickerListRow>) => {
      if (item.kind === 'header') {
        return (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderLabel}>{item.label}</Text>
            <Text style={styles.sectionHeaderCount}>{item.count}</Text>
          </View>
        );
      }
      return <PickerRow node={item.node} onPick={handlePick} />;
    },
    [handlePick],
  );

  const keyExtractor = useCallback(
    (row: PickerListRow) =>
      row.kind === 'header' ? `__header__${row.id}` : row.node.project.id,
    [],
  );

  const ListEmpty = useMemo(
    () => (
      <EmptyState
        icon="search-outline"
        title={tree.length === 0 ? 'No projects yet' : 'No matches'}
        subtitle={
          tree.length === 0
            ? 'Sync now or use Demo Mode to load sample projects.'
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

      {/*
        Sticky search bar. Lives ABOVE the FlatList (not as
        ListHeaderComponent) so the keyboard can never push it off-screen
        or cover it. The prior in-file comment named this hoist as the
        intended escape hatch. searchWrapStickyOverride zeros the legacy
        header-context marginBottom so the gap below the search bar is
        owned by list.paddingTop alone, preserving the prior visual rhythm.
      */}
      <View style={styles.searchOuter}>
        <View style={[styles.searchWrap, styles.searchWrapStickyOverride]}>
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
      </View>

      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: LIST_PADDING_BOTTOM + keyboardPadding },
        ]}
        ListEmptyComponent={ListEmpty}
        ItemSeparatorComponent={Separator}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        // Virtualization knobs tuned for the 3,226-row Studio G tenant.
        // initialNumToRender mounts 20 rows on first paint (1.5 screens
        // worth on most phones); windowSize keeps ~10 screens of cells in
        // memory; removeClippedSubviews offloads off-screen nodes from the
        // native view hierarchy on Android (no-op on iOS but harmless).
        initialNumToRender={20}
        windowSize={10}
        removeClippedSubviews
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
  // Sticky wrapper around the search bar — sits as a SafeAreaView sibling
  // of the FlatList so the keyboard can't displace it. paddingTop:12
  // preserves the breathing room the list's paddingTop used to give the
  // header row.
  searchOuter: {
    paddingHorizontal: 16,
    paddingTop: 12,
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
  // Override applied when searchWrap is the sticky search above the list
  // (not a ListHeaderComponent). Drops the legacy header-context
  // marginBottom so spacing below the search bar is owned by
  // list.paddingTop alone, preserving the prior ~12px gap to the first
  // row.
  searchWrapStickyOverride: {
    marginBottom: 0,
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
    paddingBottom: LIST_PADDING_BOTTOM,
    flexGrow: 1,
  },
  // Section header row — emits a quiet "RECENT" / "ALL PROJECTS" label
  // with a small count chip on the right. Uppercase + letter-spacing
  // mirrors the iOS Settings section-label convention so it reads as
  // chrome, not as a tappable row.
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingHorizontal: 4,
    paddingTop: 12,
    paddingBottom: 4,
  },
  sectionHeaderLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionHeaderCount: {
    fontSize: 12,
    color: colors.muted,
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
