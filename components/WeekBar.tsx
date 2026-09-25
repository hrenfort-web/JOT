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
//   1. Full pill (hoursByDay provided) — day letter, day-of-month number,
//      hours total below. Used on home, where the user is auditing the
//      week at a glance.
//   2. Compact pill (hoursByDay undefined) — day letter + day-of-month
//      number. Used inside the entry flow where the user is choosing which
//      day to log against; per-day totals aren't surfaced there.
//
// Every pill carries its day-of-month number under the letter so a
// past-week view can't be mistaken for the current one at a glance.
//
// Weekend pills (Saturday, Sunday) sit on colors.subtle instead of the
// cream surface. That tint is a background only — the selected border and
// the today accent letter are applied on top of it unchanged, so weekend
// styling never hides either state.
//
// Width budget: `days` may hold up to seven pills (visibleWeekDays firm
// setting). On a 375pt screen with the 16pt side padding and 4pt gaps
// that's (375 − 32 − 6·4) / 7 ≈ 45.6pt per pill, which fits the 16pt
// hours figure ("8.75") with room to spare. Compact pills are ~50pt tall
// and full pills ~78pt, both above the 44pt touch-target floor.
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
        // JS getDay: 0 = Sunday, 6 = Saturday.
        const jsDay = d.getDay();
        const isWeekend = jsDay === 0 || jsDay === 6;

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
        // visual pill conveys: weekday + full date, hours (when surfaced),
        // target attainment, and "today" marker. In compact mode we omit
        // hours chunks entirely since they aren't shown.
        const fullName = d.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        });
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
              isWeekend && styles.pillWeekend,
              { borderColor, borderWidth },
              pressed && styles.pillPressed,
            ]}
          >
            <Text style={[styles.dayLabel, { color: dayLabelColor }]}>
              {shortDayLabel(d)}
            </Text>
            <Text style={styles.dateLabel}>{d.getDate()}</Text>
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
    // 4pt gap (was 8) so seven pills fit a 375pt screen at ~45.6pt each.
    gap: 4,
    paddingHorizontal: 16,
  },
  pill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.surface,
    gap: 4,
  },
  pillCompact: {
    // Tighter vertical padding when there's no hours line — the pill
    // ends up roughly two-thirds height (letter + date number only),
    // which is appropriate for a day-picker strip that's just chrome
    // rather than a data display. Still clears the 44pt touch target.
    paddingVertical: 10,
  },
  pillWeekend: {
    // Saturday / Sunday tint. Background only — border and letter colour
    // for selected/today are applied separately and win.
    backgroundColor: colors.subtle,
  },
  pillPressed: {
    opacity: 0.7,
  },
  dayLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  dateLabel: {
    // Day-of-month under the letter: quieter and smaller than the letter
    // so the weekday still leads, but always present so a past week
    // reads as dated, not just lettered.
    fontSize: 10,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  hoursLabel: {
    // 16 (was 18) so a four-character figure like "8.75" sits inside a
    // ~45pt pill without clipping.
    fontSize: 16,
    fontWeight: '500',
  },
});
