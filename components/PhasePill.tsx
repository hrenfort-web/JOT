import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

interface PhasePillProps {
  code: string;
  tintColor?: string;
  size?: 'sm' | 'md';
}

export function PhasePill({ code, tintColor, size = 'md' }: PhasePillProps) {
  const tint = tintColor ?? colors.accent;
  const bg = withAlpha(tint, 0.15);
  const isLarge = size === 'md';
  return (
    <View
      style={[
        styles.pill,
        isLarge ? styles.pillMd : styles.pillSm,
        { backgroundColor: bg },
      ]}
    >
      <Text
        style={[
          styles.text,
          isLarge ? styles.textMd : styles.textSm,
          { color: tint },
        ]}
      >
        {code}
      </Text>
    </View>
  );
}

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return hex;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillSm: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pillMd: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  text: {
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  textSm: {
    fontSize: 10,
  },
  textMd: {
    fontSize: 12,
  },
});
