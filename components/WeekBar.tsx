import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { compareDay, formatHours, isSameDay, shortDayLabel, toIsoDay } from '../utils/dateHelpers';

interface WeekBarProps {
  days: Date[];
  /**
   * When provided, each pill shows the day letter PLUS the day's hours
   * total (or "—" if empty). When undefined, pills render in compact mode
   * — just the day letter — used by the entry-flow day selector where
   * per-day totals aren't surfaced. Same chrome either way.
   */
  hoursByDay?: Record<string, number>;
  selectedDate: string;
  today: Date;
  /**
   * Target hours per day (e.g. 8). Only used for the screen-reader
   * "target met" / "under target" hint. Visual treatment doesn't change
   * with target attainment in Theme B. Defaults to 8 when omitted.
   */
  targetHours?: number;
  onSelectDay: (iso: string) => void;
}

// Theme B: the week pills are neutral. No green for "met target", no red
// for "under target" — empty is just empty, and the data is allowed to be
// the celebration on its own.
//
// Highlight rules:
//   - The SELECTED day owns the 1.5px border: accent when selected==today,
//     dark text-color when selected is a different day. Exactly one pill
//     at a time has the bordered "this is chosen" treatment.
//   - TODAY (when not selected) keeps the accent-colored day letter as a
//     subtle locator, but no border — so today never competes visually
//     with the selected day. Earlier versions painted today AND selected
//     with simultaneous 1.5px borders, which read as "two days are
//     highlighted" once the selected day diverged from today.
//
// The component renders in two modes:
//   1. Full pill (hoursByDay provided) — day letter + hours total below.
//      Used on home, where the user is auditing the week at a glance.
//   2. Compact pill (hoursByDay undefined) — just the day letter, centered.
//      Used inside the entry flow where the user is choosing which day to
//      log against; per-day totals aren't surfaced there.
//
// `targetHours` informs the a11y label only (so VO users hear "target met"
// without the visual green/red cue Theme B dropped). Defaults to 8 when not
// passed.
export function WeekBar({
  days,
  hoursByDay,
  selectedDate,
  today,
  targetHours = 8,
  onSelectDay,
}: WeekBarProps) {
  const compact = hoursByDay === undefined;

  return (
    <View style={styles.row}>
      {days.map((d) => {
        const iso = toIsoDay(d);
        const hours = hoursByDay?.[iso] ?? 0;
        const isToday = isSameDay(d, today);
        const isSelected = iso === selectedDate;
        const cmp = compareDay(d, today);
        const isFuture = cmp > 0;
        const metTarget = hours >= targetHours;
        const hasHours = hours > 0;

        // Selected day owns the 1.5px border: accent when selected==today
        // (the "you're on today and it's the selected day" state), dark
        // text-color when selected is a different day. Today (when not
        // selected) keeps the accent-colored day letter as a subtle
        // locator but NO border — so exactly one pill at a time has the
        // bordered "this is chosen" treatment, never two. Default: cream
        // hairline border. No fill changes — every pill keeps the cream
        // surface so the hours number stays the point.
        const borderColor = isSelected
          ? isToday
            ? colors.accent
            : colors.text
          : colors.border;
        const borderWidth = isSelected ? 1.5 : 1;

        const dayLabelColor = isToday ? colors.accent : colors.textSecondary;
        const hoursColor = hasHours ? colors.text : colors.disabledText;

        // Compose a single screen-reader sentence covering everything the
        // visual pill conveys: day, hours (when surfaced), target
        // attainment, and "today" marker. In compact mode we omit hours
        // chunks entirely since they aren't shown.
        const fullName = d.toLocaleDateString(undefined, { weekday: 'long' });
        const hoursPhrase = compact
          ? ''
          : hours === 0
            ? isFuture
              ? ', no hours yet'
              : ', no hours logged'
            : `, ${formatHours(hours)} hours`;
        const targetPhrase = compact || isFuture
          ? ''
          : metTarget
            ? ', target met'
            : ', under target';
        const todayPhrase = isToday ? ', today' : '';
        return (
          <Pressable
            key={iso}
            onPress={() => onSelectDay(iso)}
            accessibilityRole="button"
            accessibilityLabel={`${fullName}${hoursPhrase}${targetPhrase}${todayPhrase}`}
            accessibilityState={{ selected: isSelected }}
            style={({ pressed }) => [
              styles.pill,
              compact && styles.pillCompact,
              { borderColor, borderWidth },
              pressed && styles.pillPressed,
            ]}
          >
            <Text style={[styles.dayLabel, { color: dayLabelColor }]}>
              {shortDayLabel(d)}
            </Text>
            {compact ? null : (
              <Text style={[styles.hoursLabel, { color: hoursColor }]}>
                {hours === 0 ? '—' : formatHours(hours)}
              </Text>
            )}
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
    backgroundColor: colors.surface,
    gap: 6,
  },
  pillCompact: {
    // Tighter vertical padding when there's no hours line — the pill
    // ends up roughly half-height, which is appropriate for a day-picker
    // strip that's just chrome rather than a data display.
    paddingVertical: 10,
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
