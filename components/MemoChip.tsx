import { Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

interface MemoChipProps {
  label: string;
  /**
   * Persistent visual state: the user has tapped this chip at least once
   * during the current entry session and the memo field reflects it.
   * Composes with `repeated` and `primed` — selected wins visually so a
   * confirmed chip-tap reads the same regardless of repeat status.
   */
  selected?: boolean;
  /**
   * The memo behind this chip has been submitted >= REPEAT_THRESHOLD
   * times by the current user this week. Hours screen flags it so the
   * user can scan for "auto-pilot risk" before tapping.
   */
  repeated?: boolean;
  /**
   * The user just tapped this repeated chip; a second tap within
   * REPEAT_TIMEOUT_MS confirms and fills the memo. The chip flips to a
   * solid-accent fill so the pending-confirm state is unmistakable.
   */
  primed?: boolean;
  onPress: () => void;
}

// Theme B memo chip. Five layered visual states with explicit
// precedence (later styles in the array win):
//
//   default                — cream surface, hairline border, text primary
//   repeated               — cream surface, 1.5px accent border, text primary
//   primed                 — solid accent fill, accent border, cream text
//   selected               — accent-muted fill, accent border, accent text
//   pressed (transient)    — opacity ramp on whichever state is current
//
// Per spec ordering: selected > primed > repeated > default. The style
// array below applies them in that order so the final render reflects
// the precedence cleanly.
export function MemoChip({
  label,
  selected,
  repeated,
  primed,
  onPress,
}: MemoChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        repeated && styles.chipRepeated,
        primed && styles.chipPrimed,
        selected && styles.chipSelected,
        pressed && styles.chipPressed,
      ]}
    >
      <Text
        style={[
          styles.text,
          primed && styles.textPrimed,
          selected && styles.textSelected,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 40,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  // Repeated state — same cream surface as default but with a thicker
  // accent border. Subtle hint that "this one has weight" without
  // shouting; the today-pill in WeekBar uses the same accent-border-on-
  // cream-fill pattern.
  chipRepeated: {
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  // Primed state — solid accent fill, accent border. Visually unmistakable
  // that a tap is pending confirmation. Cream text on accent for contrast.
  chipPrimed: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderWidth: 1.5,
  },
  // Selected state — existing accent-muted treatment. Wins over primed
  // and repeated so a confirmed (memo-filled) chip reads consistently.
  chipSelected: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
    borderWidth: 1.5,
  },
  chipPressed: {
    opacity: 0.7,
  },
  text: {
    fontSize: 14,
    fontWeight: '400',
    color: colors.text,
  },
  textPrimed: {
    color: colors.surface,
    fontWeight: '500',
  },
  textSelected: {
    color: colors.accent,
    fontWeight: '500',
  },
});
