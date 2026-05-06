import { create } from 'zustand';
import {
  DEFAULT_REMINDER_PREFS,
  ReminderPrefs,
  loadReminderPrefs,
  saveReminderPrefs,
} from '../utils/preferences';
import {
  getNotificationPermission,
  rescheduleAllReminders,
} from '../services/notifications/reminders';

interface ReminderState {
  prefs: ReminderPrefs;
  isLoaded: boolean;
  permissionGranted: boolean;
  permissionCanAskAgain: boolean;

  load: () => Promise<void>;
  refreshPermission: () => Promise<void>;
  updatePrefs: (patch: Partial<ReminderPrefs>) => Promise<void>;
}

export const useReminderStore = create<ReminderState>((set, get) => ({
  prefs: DEFAULT_REMINDER_PREFS,
  isLoaded: false,
  permissionGranted: false,
  permissionCanAskAgain: true,

  load: async () => {
    const [prefs, permission] = await Promise.all([
      loadReminderPrefs(),
      getNotificationPermission(),
    ]);
    set({
      prefs,
      isLoaded: true,
      permissionGranted: permission.granted,
      permissionCanAskAgain: permission.canAskAgain,
    });
  },

  refreshPermission: async () => {
    const permission = await getNotificationPermission();
    set({
      permissionGranted: permission.granted,
      permissionCanAskAgain: permission.canAskAgain,
    });
  },

  updatePrefs: async (patch) => {
    const next = { ...get().prefs, ...patch };
    set({ prefs: next });
    await saveReminderPrefs(next);
    await rescheduleAllReminders(next);
  },
}));
