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
  scanConsentAcceptedAt: 'jot_scan_consent_accepted_at',
} as const;

/**
 * scanConsentAcceptedAt — ISO timestamp of when the user accepted the
 * scan-consent screen (app/scan-consent.tsx), or null if never. Per
 * device, same store and persistence as the other keys in this module.
 * Read by the Scan tab gate (via store/useScanConsentStore) and, as a
 * defence in depth, by services/ai/scanner.ts before any request is built.
 */
export async function loadScanConsentAcceptedAt(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync(PREF_KEYS.scanConsentAcceptedAt);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export async function saveScanConsentAcceptedAt(iso: string | null): Promise<void> {
  try {
    if (iso === null) {
      await SecureStore.deleteItemAsync(PREF_KEYS.scanConsentAcceptedAt);
    } else {
      await SecureStore.setItemAsync(PREF_KEYS.scanConsentAcceptedAt, iso);
    }
  } catch {
    // ignore — the in-memory store still reflects the choice for this
    // session; the gate shows again next launch if the write was lost.
  }
}

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
