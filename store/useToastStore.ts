import { create } from 'zustand';
import * as Haptics from 'expo-haptics';

export type ToastKind = 'success' | 'error' | 'info';

interface ToastState {
  message: string | null;
  kind: ToastKind;
  show: (message: string, kind?: ToastKind, durationMs?: number) => void;
  hide: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function fireHaptic(kind: ToastKind): void {
  if (kind === 'success') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  } else if (kind === 'error') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  }
}

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  kind: 'info',
  show: (message, kind = 'info', durationMs = 2500) => {
    if (timer) clearTimeout(timer);
    set({ message, kind });
    fireHaptic(kind);
    timer = setTimeout(() => {
      set({ message: null });
      timer = null;
    }, durationMs);
  },
  hide: () => {
    if (timer) clearTimeout(timer);
    timer = null;
    set({ message: null });
  },
}));
