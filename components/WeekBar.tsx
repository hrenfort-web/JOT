import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { formatHours, isSameDay, shortDayLabel, toIsoDay } from '../utils/dateHelpers';

interface WeekBarProps {
  days: Date[];
  hoursByDay: Record<string, number>;
  selectedDate: string;
  today: Date;
  onSelectDay: (iso: string) => void;
}

export function WeekBar({ days, hoursByDay, selectedDate, today, onSelectDay }: WeekBarProps) {
  return (
    <View style={styles.row}>
      {days.map((d) => {
        const iso = toIsoDay(d);
        const hours = hoursByDay[iso] ?? 0;
        const isToday = isSameDay(d, today);
        const isSelected = iso === selectedDate;
        return (
          <Pressable
            key={iso}
            onPress={() => onSelectDay(iso)}
            style={({ pressed }) => [
              styles.pill,
              isSelected && !isToday && styles.pillSelected,
              isToday && styles.pillToday,
              pressed && styles.pillPressed,
            ]}
          >
            <Text style={[styles.dayLabel, isToday && styles.todayText]}>
              {shortDayLabel(d)}
            </Text>
            <Text
              style={[
                styles.hoursLabel,
                hours === 0 && styles.zeroHours,
                isToday && styles.todayText,
              ]}
            >
              {hours === 0 ? '—' : formatHours(hours)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  pill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  pillSelected: {
    backgroundColor: colors.subtle,
    borderColor: colors.text,
  },
  pillToday: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pillPressed: {
    opacity: 0.75,
  },
  dayLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
  },
  hoursLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  zeroHours: {
    color: colors.muted,
    fontWeight: '500',
  },
  todayText: {
    color: '#FFFFFF',
  },
});
