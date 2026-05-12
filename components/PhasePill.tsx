import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

interface PhasePillProps {
  code: string;
  // Retained for API back-compat with existing call sites (e.g. EntryRow,
  // ProjectCard pass the project's color in). Theme B intentionally
  // IGNORES it — every phase badge renders in the accent-muted treatment
  // so a project list stays calm against the cream surfaces. A row of
  // bright-blue / bright-amber / bright-pink badges (one per phase code
  // colour) shattered the palette.
  tintColor?: string;
  size?: 'sm' | 'md';
}

export function PhasePill({ code, size = 'md' }: PhasePillProps) {
  const isLarge = size === 'md';
  return (
    <View style={[styles.pill, isLarge ? styles.pillMd : styles.pillSm]}>
      <Text style={[styles.text, isLarge ? styles.textMd : styles.textSm]}>
        {code}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    // Unified accent-muted treatment: #F0E2D5 background + #C75D2C label.
    // No per-phase colour any more — the project dot already carries
    // identity, and the badge is just a phase-code chip.
    backgroundColor: colors.accentTint,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillSm: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pillMd: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  text: {
    color: colors.accent,
    fontWeight: '500',
  },
  textSm: {
    fontSize: 11,
  },
  textMd: {
    fontSize: 12,
  },
});
