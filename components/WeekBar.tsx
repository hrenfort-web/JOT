import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { compareDay, formatHours, isSameDay, shortDayLabel, toIsoDay } from '../utils/dateHelpers';

interface WeekBarProps {
  days: Date[];
  hoursByDay: Record<string, number>;
  selectedDate: string;
  today: Date;
  targetHours: number;
  onSelectDay: (iso: string) => void;
}

const GREEN_BG = '#D1FAE5';
const GREEN_TEXT = '#065F46';
const RED_BG = '#FEE2E2';
const RED_TEXT = '#991B1B';

export function WeekBar({
  days,
  hoursByDay,
  selectedDate,
  today,
  targetHours,
  onSelectDay,
}: WeekBarProps) {
  return (
    <View style={styles.row}>
      {days.map((d) => {
        const iso = toIsoDay(d);
        const hours = hoursByDay[iso] ?? 0;
        const isToday = isSameDay(d, today);
        const isSelected = iso === selectedDate;
        const cmp = compareDay(d, today);
        const isFuture = cmp > 0;
        const metTarget = hours >= targetHours;

        let bg: string = colors.background;
        let textColor: string = colors.text;
        let labelColor: string = colors.muted;
        let hoursColor: string = colors.text;

        if (!isFuture) {
          if (metTarget) {
            bg = GREEN_BG;
            textColor = GREEN_TEXT;
            labelColor = GREEN_TEXT;
            hoursColor = GREEN_TEXT;
          } else {
            bg = RED_BG;
            textColor = RED_TEXT;
            labelColor = RED_TEXT;
            hoursColor = RED_TEXT;
          }
        }

        const borderColor = isToday
          ? colors.accent
          : isSelected
            ? colors.text
            : colors.border;
        const borderWidth = isToday || isSelected ? 2 : 1;

        return (
          <Pressable
            key={iso}
            onPress={() => onSelectDay(iso)}
            style={({ pressed }) => [
              styles.pill,
              { backgroundColor: bg, borderColor, borderWidth },
              pressed && styles.pillPressed,
            ]}
          >
            <Text
              style={[
                styles.dayLabel,
                { color: labelColor },
                isToday && styles.dayLabelToday,
              ]}
            >
              {shortDayLabel(d)}
            </Text>
            <Text
              style={[
                styles.hoursLabel,
                { color: hoursColor },
                hours === 0 && isFuture && styles.zeroFuture,
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
    gap: 4,
  },
  pillPressed: {
    opacity: 0.75,
  },
  dayLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  dayLabelToday: {
    fontWeight: '700',
  },
  hoursLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  zeroFuture: {
    color: colors.muted,
    fontWeight: '500',
  },
});
