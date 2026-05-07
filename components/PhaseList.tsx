import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { phaseMeta } from '../utils/phaseMeta';
import type { LocalProject } from '../db/schema';

export interface PhaseGroup {
  /** Header text. Pass `null` to render the rows ungrouped (no header). */
  title: string | null;
  phases: LocalProject[];
}

interface PhaseListProps {
  groups: PhaseGroup[];
  onPickPhase: (phaseId: string) => void;
  searchEnabled?: boolean;
  searchValue?: string;
  onChangeSearch?: (next: string) => void;
}

/**
 * Compact, single-column phase list used when a project has 7+ phases. Each
 * row shows the phase icon, a code badge, and the phase name. Optional groups
 * separate "Recently used" from "Other phases", and an optional search bar
 * sits at the top for projects with 12+ phases.
 */
export function PhaseList({
  groups,
  onPickPhase,
  searchEnabled = false,
  searchValue = '',
  onChangeSearch,
}: PhaseListProps) {
  const totalPhases = groups.reduce((acc, g) => acc + g.phases.length, 0);

  return (
    <View style={styles.container}>
      {searchEnabled ? (
        <View style={styles.searchWrap}>
          <Ionicons
            name="search-outline"
            size={18}
            color={colors.muted}
            style={styles.searchIcon}
          />
          <TextInput
            style={styles.searchInput}
            value={searchValue}
            onChangeText={onChangeSearch}
            placeholder="Search phases"
            placeholderTextColor={colors.muted}
            autoCorrect={false}
            autoCapitalize="characters"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      ) : null}

      {totalPhases === 0 ? (
        <Text style={styles.empty}>No phases match.</Text>
      ) : (
        groups.map((group, groupIndex) => {
          if (group.phases.length === 0) return null;
          return (
            <View key={group.title ?? `group-${groupIndex}`} style={styles.group}>
              {group.title ? (
                <Text style={styles.groupHeader}>{group.title}</Text>
              ) : null}
              {group.phases.map((phase) => {
                const meta = phaseMeta(phase.phaseCode, phase.name);
                return (
                  <Pressable
                    key={phase.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${meta.name}, phase ${meta.code}`}
                    onPress={() => onPickPhase(phase.id)}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && styles.rowPressed,
                    ]}
                  >
                    <View style={styles.iconWrap}>
                      <Ionicons name={meta.icon} size={18} color={colors.accent} />
                    </View>
                    <View style={styles.codeBadge}>
                      <Text style={styles.codeBadgeText}>{meta.code}</Text>
                    </View>
                    <Text style={styles.name} numberOfLines={1}>
                      {meta.name}
                    </Text>
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color={colors.muted}
                    />
                  </Pressable>
                );
              })}
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 16,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.subtle,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchIcon: {
    marginLeft: 2,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    paddingVertical: 0,
  },
  group: {
    gap: 8,
  },
  groupHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 4,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowPressed: {
    backgroundColor: colors.subtle,
    borderColor: colors.accent,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBadge: {
    minWidth: 36,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.subtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 0.5,
  },
  name: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
  },
  empty: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    paddingVertical: 32,
  },
});
