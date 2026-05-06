import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { getAll } from '../../db/database';
import {
  PREF_KEYS,
  ReminderPrefs,
  loadReminderPrefs,
} from '../../utils/preferences';
import {
  formatHours,
  getMonday,
  getSunday,
  toIsoDay,
} from '../../utils/dateHelpers';

const DAILY_THRESHOLD = 6;
const THURSDAY_THRESHOLD = 32;
const FRIDAY_THRESHOLD = 38;

const THURSDAY_HOUR = 16;
const FRIDAY_HOUR = 16;

const ID = {
  daily: (jsWeekday: number) => `jot-daily-${jsWeekday}`,
  thursdayWarning: 'jot-thursday-warning',
  fridayDeadline: 'jot-friday-deadline',
};

const ALL_IDS = [
  ...[1, 2, 3, 4, 5].map((w) => ID.daily(w)),
  ID.thursdayWarning,
  ID.fridayDeadline,
];

let configured = false;

export function configureNotificationHandler(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

export async function getNotificationPermission(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
}> {
  const settings = await Notifications.getPermissionsAsync();
  return {
    granted: settings.status === 'granted',
    canAskAgain: settings.canAskAgain ?? true,
  };
}

export async function requestNotificationPermission(): Promise<boolean> {
  const current = await getNotificationPermission();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;

  const result = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
    },
  });

  await SecureStore.setItemAsync(PREF_KEYS.notifPermissionAsked, 'true').catch(() => {});
  return result.status === 'granted';
}

export async function ensurePermissionRequestedOnce(): Promise<boolean> {
  const asked = await SecureStore.getItemAsync(PREF_KEYS.notifPermissionAsked).catch(() => null);
  if (asked) {
    const current = await getNotificationPermission();
    return current.granted;
  }
  return requestNotificationPermission();
}

export async function cancelAllReminders(): Promise<void> {
  await Promise.all(
    ALL_IDS.map((id) =>
      Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined),
    ),
  );
}

interface DayHoursMap {
  [iso: string]: number;
}

async function getCurrentWeekHoursByDay(): Promise<DayHoursMap> {
  const today = new Date();
  const start = toIsoDay(getMonday(today));
  const end = toIsoDay(getSunday(today));
  const rows = await getAll<{ date: string; hours: number }>(
    `SELECT date, SUM(hours) as hours
     FROM LocalTimeEntry
     WHERE date >= ? AND date <= ?
     GROUP BY date`,
    [start, end],
  );
  const map: DayHoursMap = {};
  for (const r of rows) map[r.date] = r.hours;
  return map;
}

function isoForWeekday(jsWeekday: number, weekStart: Date): string {
  const d = new Date(weekStart);
  d.setDate(weekStart.getDate() + (jsWeekday - 1));
  return toIsoDay(d);
}

function jsWeekdayToExpo(jsWeekday: number): number {
  return (jsWeekday % 7) + 1;
}

async function updateBadgeCount(hoursByDay: DayHoursMap): Promise<void> {
  const today = new Date();
  const todayIso = toIsoDay(today);
  const monday = getMonday(today);
  let shortCount = 0;
  for (let i = 0; i < 5; i++) {
    const iso = isoForWeekday(i + 1, monday);
    if (iso > todayIso) break;
    if ((hoursByDay[iso] ?? 0) < DAILY_THRESHOLD) shortCount += 1;
  }
  try {
    await Notifications.setBadgeCountAsync(shortCount);
  } catch {
    // setBadgeCountAsync can fail on some platforms; ignore
  }
}

export async function rescheduleAllReminders(prefsOverride?: ReminderPrefs): Promise<void> {
  await cancelAllReminders();

  const prefs = prefsOverride ?? (await loadReminderPrefs());
  if (!prefs.enabled) {
    try {
      await Notifications.setBadgeCountAsync(0);
    } catch {
      // ignore
    }
    return;
  }

  const permission = await getNotificationPermission();
  if (!permission.granted) return;

  const today = new Date();
  const todayIso = toIsoDay(today);
  const todayJsWeekday = today.getDay();
  const monday = getMonday(today);
  const hoursByDay = await getCurrentWeekHoursByDay();
  const weekTotal = Object.values(hoursByDay).reduce((s, v) => s + v, 0);

  for (let jsWeekday = 1; jsWeekday <= 5; jsWeekday++) {
    const dayIso = isoForWeekday(jsWeekday, monday);
    const hoursThatDay = hoursByDay[dayIso] ?? 0;

    if (jsWeekday === todayJsWeekday && hoursThatDay >= DAILY_THRESHOLD) {
      continue;
    }

    await Notifications.scheduleNotificationAsync({
      identifier: ID.daily(jsWeekday),
      content: {
        title: 'Jot',
        body:
          dayIso === todayIso
            ? `You've logged ${formatHours(hoursThatDay)} of ${prefs.targetPerDay} hours today`
            : `Daily reminder: log your ${prefs.targetPerDay} hours`,
        data: { route: '/' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: jsWeekdayToExpo(jsWeekday),
        hour: prefs.hour,
        minute: prefs.minute,
      },
    });
  }

  if (weekTotal < THURSDAY_THRESHOLD) {
    const remaining = Math.max(0, prefs.targetPerWeek - weekTotal);
    await Notifications.scheduleNotificationAsync({
      identifier: ID.thursdayWarning,
      content: {
        title: 'Jot',
        body: `You have ${formatHours(remaining)} hours remaining this week`,
        data: { route: '/' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: jsWeekdayToExpo(4),
        hour: THURSDAY_HOUR,
        minute: 0,
      },
    });
  }

  if (weekTotal < FRIDAY_THRESHOLD) {
    const short = Math.max(0, prefs.targetPerWeek - weekTotal);
    await Notifications.scheduleNotificationAsync({
      identifier: ID.fridayDeadline,
      content: {
        title: 'Timecards due!',
        body: `You're ${formatHours(short)} hours short`,
        data: { route: '/' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: jsWeekdayToExpo(5),
        hour: FRIDAY_HOUR,
        minute: 0,
      },
    });
  }

  await updateBadgeCount(hoursByDay);
}
