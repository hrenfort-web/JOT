import { Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

interface FloatingActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}

/**
 * Extended (pill-shaped) FAB. Material-style: rounded rectangle, leading
 * icon, trailing text label. Sits at bottom-right with a soft drop shadow.
 * Renders as a single Pressable so the whole pill is one tap target.
 *
 * Theme B: accent background, cream surface foreground (NOT pure white —
 * cream picks up the page tone so the FAB looks like part of the paper,
 * not a sticker on top of it). Pressed state swaps to accentPressed
 * (#243E6B) instead of opacity, matching the login button.
 */
export function FloatingActionButton({
  icon,
  label,
  onPress,
  accessibilityLabel,
}: FloatingActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
    >
      <Ionicons name={icon} size={24} color={colors.surface} />
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 60,
    paddingHorizontal: 24,
    borderRadius: 30,
    backgroundColor: colors.accent,
    // Shadow tuned for the warm cream page — a pure black shadow at 22%
    // reads cold on cream. Drop opacity slightly and let the shadow carry
    // the elevation without staining the page.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  fabPressed: {
    backgroundColor: colors.accentPressed,
  },
  label: {
    color: colors.surface,
    fontSize: 17,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});
