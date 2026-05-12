import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { formatHours } from '../utils/dateHelpers';

interface SummaryPillProps {
  label: string;
  hours: number;
  variant?: 'default' | 'accent';
}

// Theme B summary tile.
//
//   variant='accent' (used for "Logged") — accentTint background + accent
//     value/label. This is the only place on the home screen where the
//     accent fills a surface; it's the one positive-state celebration.
//   variant='default' (used for "Remaining") — surface cream with the
//     hairline border. Neutral by design: missing hours are not a problem,
//     they're just data not yet entered.
//
// Typography is intentionally restrained: a 36px value reads as the focal
// number, an 11px sentence-case label reads as caption. No uppercase chrome
// — the data carries weight on its own.
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
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 6,
  },
  pillAccent: {
    backgroundColor: colors.accentTint,
    // Border matches the tint exactly — no double-line effect on the
    // accent variant. We rely on colour contrast against the cream page
    // background to separate the tile from its surround.
    borderColor: colors.accentTint,
  },
  label: {
    // Sentence case ("Logged" / "Remaining"), 11px, weight 500. The
    // old uppercase + tracking treatment was chrome-noise — Theme B
    // collapses the label to a quiet caption.
    fontSize: 11,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  labelAccent: {
    color: colors.accent,
  },
  value: {
    fontSize: 36,
    fontWeight: '500',
    color: colors.text,
  },
  valueAccent: {
    color: colors.accent,
  },
  unit: {
    // Unit follows the value's colour but at a smaller body-text size so
    // "12 h" reads as a number with a unit, not a runaway display.
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  unitAccent: {
    color: colors.accent,
  },
});
