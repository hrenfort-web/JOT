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
  return (
    <Pressable
      onPress={onPress}
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
        <Ionicons name="chevron-forward" size={18} color={colors.muted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
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
    fontWeight: '600',
    color: colors.text,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hours: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    minWidth: 36,
    textAlign: 'right',
  },
  hoursZero: {
    color: colors.muted,
  },
});
