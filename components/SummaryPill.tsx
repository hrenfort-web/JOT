import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { formatHours } from '../utils/dateHelpers';

interface SummaryPillProps {
  label: string;
  hours: number;
  variant?: 'default' | 'accent';
}

export function SummaryPill({ label, hours, variant = 'default' }: SummaryPillProps) {
  const accent = variant === 'accent';
  return (
    <View style={[styles.pill, accent && styles.pillAccent]}>
      <Text style={[styles.label, accent && styles.labelAccent]}>{label}</Text>
      <Text style={[styles.value, accent && styles.valueAccent]}>
        {formatHours(hours)}
        <Text style={[styles.unit, accent && styles.unitAccent]}> h</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 4,
  },
  pillAccent: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accentTint,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  labelAccent: {
    color: colors.accent,
  },
  value: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  valueAccent: {
    color: colors.accent,
  },
  unit: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.muted,
  },
  unitAccent: {
    color: colors.accent,
  },
});
