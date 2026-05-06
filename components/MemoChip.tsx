import { Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

interface MemoChipProps {
  label: string;
  selected?: boolean;
  onPress: () => void;
}

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
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.subtle,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipSelected: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
  },
  chipPressed: {
    opacity: 0.7,
  },
  text: {
    fontSize: 13,
    color: colors.text,
    fontWeight: '500',
  },
  textSelected: {
    color: colors.accent,
    fontWeight: '600',
  },
});
