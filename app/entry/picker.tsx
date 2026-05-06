import { useMemo, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
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

  const handlePick = (projectId: string) => {
    router.push(`/entry/${projectId}`);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ title: 'Pick a project' }} />

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
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon="search-outline"
            title={tree.length === 0 ? 'No projects yet' : 'No matches'}
            subtitle={
              tree.length === 0
                ? 'Sync with BQE Core or use Demo Mode to load sample projects.'
                : 'Try a shorter search or check the spelling.'
            }
          />
        ) : (
          filtered.map((node) => {
            const project = node.project;
            return (
              <Pressable
                key={project.id}
                onPress={() => handlePick(project.id)}
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
                  {project.clientName ? (
                    <Text style={styles.client} numberOfLines={1}>
                      {project.clientName}
                    </Text>
                  ) : project.code ? (
                    <Text style={styles.client} numberOfLines={1}>
                      {project.code}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.muted} />
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
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
    marginHorizontal: 16,
    marginTop: 12,
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
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
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
