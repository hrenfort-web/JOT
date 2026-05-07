import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { isSameDay, shortDayLabel, toIsoDay } from '../utils/dateHelpers';

interface DaySelectorProps {
  days: Date[];
  selectedDate: string;
  today: Date;
  onSelectDay: (iso: string) => void;
}

export function DaySelector({ days, selectedDate, today, onSelectDay }: DaySelectorProps) {
  return (
    <View style={styles.row}>
      {days.map((d) => {
        const iso = toIsoDay(d);
        const isToday = isSameDay(d, today);
        const isSelected = iso === selectedDate;
        // Full weekday name for screen readers; the visible "Mon" pill is
        // ambiguous when read out as plain text.
        const fullName = d.toLocaleDateString(undefined, { weekday: 'long' });
        return (
          <Pressable
            key={iso}
            onPress={() => onSelectDay(iso)}
            accessibilityRole="button"
            accessibilityLabel={isToday ? `${fullName}, today` : fullName}
            accessibilityState={{ selected: isSelected }}
            style={({ pressed }) => [
              styles.tab,
              isSelected && styles.tabSelected,
              isSelected && isToday && styles.tabSelectedToday,
              pressed && styles.tabPressed,
            ]}
          >
            <Text
              style={[
                styles.label,
                isToday && !isSelected && styles.labelToday,
                isSelected && styles.labelSelected,
              ]}
            >
              {shortDayLabel(d)}
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
    paddingVertical: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.subtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabSelected: {
    backgroundColor: colors.text,
  },
  tabSelectedToday: {
    backgroundColor: colors.accent,
  },
  tabPressed: {
    opacity: 0.75,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
  },
  labelToday: {
    color: colors.accent,
  },
  labelSelected: {
    color: '#FFFFFF',
  },
});
