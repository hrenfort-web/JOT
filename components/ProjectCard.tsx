import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { formatHours } from '../utils/dateHelpers';
import { PhasePill } from './PhasePill';

interface ProjectCardProps {
  name: string;
  phaseLabel: string | null;
  hours: number;
  color: string;
  onPress: () => void;
}

export function ProjectCard({ name, phaseLabel, hours, color, onPress }: ProjectCardProps) {
  // a11y: roll the visible chrome (project name, optional phase pill, hours
  // total, chevron) into a single spoken string so screen-reader users get
  // the same glanceable summary sighted users do. "0 hours this week" reads
  // better than just the visible em-dash.
  const phaseChunk = phaseLabel ? `, phase ${phaseLabel}` : '';
  const hoursChunk =
    hours === 0
      ? ', no hours logged this week'
      : `, ${formatHours(hours)} hours this week`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}${phaseChunk}${hoursChunk}`}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
      </View>
      <View style={styles.right}>
        {phaseLabel ? (
          <PhasePill code={phaseLabel} tintColor={color} />
        ) : null}
        <Text style={[styles.hours, hours === 0 && styles.hoursZero]}>
          {hours === 0 ? '—' : `${formatHours(hours)}h`}
        </Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Theme B project card: cream surface + barely-visible hairline border
  // (rgba 8% black). The colour dot and project name carry identity; the
  // chrome stays out of the way so the list reads as a calm column rather
  // than a stack of competing cards.
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  cardPressed: {
    backgroundColor: colors.subtle,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  body: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.text,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hours: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
    minWidth: 36,
    textAlign: 'right',
  },
  hoursZero: {
    // Empty state stays neutral grey, never red/pink. No hours yet is
    // not a problem — it's just data that hasn't been entered.
    color: colors.textTertiary,
  },
});
