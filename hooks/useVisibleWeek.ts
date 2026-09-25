import { useMemo } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { FIRM_SETTING_KEYS, parseVisibleWeekDays } from '../services/firmSettings';
import { getWeekDays } from '../utils/dateHelpers';

/**
 * The ONLY display-side reader of the `visibleWeekDays` firm setting.
 *
 * Returns how many days, counting from Monday, the day pills should show
 * (5..7; default 7 when the setting is absent). Subscribes to
 * useProjectStore.firmSettings, the in-memory mirror of LocalFirmSettings,
 * so a re-seed or future settings edit re-renders the pills without a
 * restart.
 *
 * Display-only: loadWeek's fetch range, the Logged/Remaining totals,
 * Submit Week, and reminders always cover Monday–Sunday regardless of
 * this value. Weekend entries on a hidden day are still fetched, counted,
 * and submitted — they just have no pill to tap.
 */
export function useVisibleWeekDayCount(): number {
  const raw = useProjectStore(
    (s) => s.firmSettings[FIRM_SETTING_KEYS.VISIBLE_WEEK_DAYS],
  );
  return parseVisibleWeekDays(raw);
}

/**
 * The Date objects for the visible pills of the week starting on `monday`
 * (a start-of-day local Date from getMonday). Memoised on the Monday's
 * timestamp and the setting so callers can pass it straight to WeekBar.
 */
export function useVisibleWeekDays(monday: Date): Date[] {
  const count = useVisibleWeekDayCount();
  return useMemo(() => getWeekDays(monday, count), [monday, count]);
}
