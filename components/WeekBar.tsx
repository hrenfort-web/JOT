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

// Theme B: the week pills are now neutral. No green for "met target", no red
// for "under target" — empty is just empty, and the data is allowed to be the
// celebration on its own. The only chrome accent is today's-day, which gets
// an orange BORDER (not fill) so the hours number stays readable. See
// theme.ts for the full Theme B rationale.
//
// The `targetHours` prop is intentionally retained even though it no longer
// drives pill color — it still informs the accessibility label so VO users
// hear "target met" / "under target" without the visual cue.
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
        const hasHours = hours > 0;

        // Today: 1.5px accent border + accent day letter. Selected (but
        // not today): subtle 1.5px dark border so the user can still see
        // which day they tapped. Default: cream hairline border. No fill
        // changes — every pill keeps the cream surface so the hours
        // number stays the point.
        const borderColor = isToday
          ? colors.accent
          : isSelected
            ? colors.text
            : colors.border;
        const borderWidth = isToday || isSelected ? 1.5 : 1;

        // Day letter colour:
        //   today → accent (the only chromatic emphasis)
        //   otherwise → textSecondary (#5C5C5A)
        const dayLabelColor = isToday ? colors.accent : colors.textSecondary;

        // Hours value colour:
        //   logged hours → text primary (#1A1A1A), even on today
        //   empty (past/today/future) → disabled grey for the em-dash
        const hoursColor = hasHours ? colors.text : colors.disabledText;

        // Compose a single screen-reader sentence covering everything the
        // visual pill conveys: day, hours, target attainment, and "today"
        // marker. VO users otherwise lose the contextual meaning that the
        // visual treatment used to carry (green/red is gone, but the
        // semantics live on in the label).
        const fullName = d.toLocaleDateString(undefined, { weekday: 'long' });
        const hoursPhrase =
          hours === 0
            ? isFuture
              ? 'no hours yet'
              : 'no hours logged'
            : `${formatHours(hours)} hours`;
        const targetPhrase = !isFuture
          ? metTarget
            ? ', target met'
            : ', under target'
          : '';
        const todayPhrase = isToday ? ', today' : '';
        return (
          <Pressable
            key={iso}
            onPress={() => onSelectDay(iso)}
            accessibilityRole="button"
            accessibilityLabel={`${fullName}, ${hoursPhrase}${targetPhrase}${todayPhrase}`}
            accessibilityState={{ selected: isSelected }}
            style={({ pressed }) => [
              styles.pill,
              { borderColor, borderWidth },
              pressed && styles.pillPressed,
            ]}
          >
            <Text style={[styles.dayLabel, { color: dayLabelColor }]}>
              {shortDayLabel(d)}
            </Text>
            <Text style={[styles.hoursLabel, { color: hoursColor }]}>
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
    paddingVertical: 12,
    borderRadius: 12,
    // Surface — cream, lifted off the page background, regardless of
    // logged/empty/today. Today is denoted only by the border.
    backgroundColor: colors.surface,
    gap: 6,
  },
  pillPressed: {
    opacity: 0.7,
  },
  dayLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  hoursLabel: {
    fontSize: 18,
    fontWeight: '500',
  },
});
