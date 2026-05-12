import { Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

interface MemoChipProps {
  label: string;
  selected?: boolean;
  onPress: () => void;
}

// Theme B memo chip — bumped for thumb-friendliness (H's call). 40px tall,
// generous horizontal padding, fully pill-shaped. Default: cream surface
// + hairline border. Tapped (selected): accent-muted fill + subtle accent
// border + accent text. The selected state persists visually so the user
// can see which chips contributed to the composed memo.
export function MemoChip({ label, selected, onPress }: MemoChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.text, selected && styles.textSelected]} numberOfLines={1}>
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
  chipSelected: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
  },
  chipPressed: {
    opacity: 0.7,
  },
  text: {
    fontSize: 14,
    fontWeight: '400',
    color: colors.text,
  },
  textSelected: {
    color: colors.accent,
    fontWeight: '500',
  },
});
