import * as SecureStore from 'expo-secure-store';

export async function loadBooleanPref(key: string, fallback: boolean): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    if (raw === null || raw === undefined) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

export async function saveBooleanPref(key: string, value: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value ? 'true' : 'false');
  } catch {
    // ignore — non-critical UI preference
  }
}

export const PREF_KEYS = {
  scanTipCollapsed: 'jot_scan_tip_collapsed',
  reminderPrefs: 'jot_reminder_prefs',
  notifPermissionAsked: 'jot_notif_permission_asked',
} as const;

export interface ReminderPrefs {
  enabled: boolean;
  hour: number;
  minute: number;
  targetPerDay: number;
  targetPerWeek: number;
}

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  enabled: true,
  hour: 17,
  minute: 0,
  targetPerDay: 8,
  targetPerWeek: 40,
};

export async function loadReminderPrefs(): Promise<ReminderPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(PREF_KEYS.reminderPrefs);
    if (!raw) return DEFAULT_REMINDER_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReminderPrefs>;
    return { ...DEFAULT_REMINDER_PREFS, ...parsed };
  } catch {
    return DEFAULT_REMINDER_PREFS;
  }
}

export async function saveReminderPrefs(prefs: ReminderPrefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(PREF_KEYS.reminderPrefs, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
