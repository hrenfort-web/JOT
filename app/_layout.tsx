import { useEffect } from 'react';
import { ActivityIndicator, AppState, StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../theme';
import { useAuthStore } from '../store/useAuthStore';
import { Toast } from '../components/Toast';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  addConnectivityListener,
  refreshConnectivity,
  startConnectivityMonitor,
  stopConnectivityMonitor,
} from '../services/sync/connectivity';
import { processQueue } from '../services/sync/queue';
import { useEntryStore } from '../store/useEntryStore';
import * as Notifications from 'expo-notifications';
import {
  configureNotificationHandler,
  ensurePermissionRequestedOnce,
  rescheduleAllReminders,
} from '../services/notifications/reminders';
import { useReminderStore } from '../store/useReminderStore';

configureNotificationHandler();

function useProtectedRoute() {
  const segments = useSegments();
  const router = useRouter();
  const isReady = useAuthStore((s) => s.isReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isReady) return;
    const inAuthGroup = segments[0] === 'auth';

    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/auth/login');
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/');
    }
  }, [isReady, isAuthenticated, segments]);
}

export default function RootLayout() {
  const router = useRouter();
  const scheme = useColorScheme();
  const isReady = useAuthStore((s) => s.isReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loadStoredTokens = useAuthStore((s) => s.loadStoredTokens);
  const loadReminderState = useReminderStore((s) => s.load);

  useEffect(() => {
    loadStoredTokens();
  }, [loadStoredTokens]);

  useProtectedRoute();

  useEffect(() => {
    if (!isAuthenticated) return;

    startConnectivityMonitor();

    const triggerSync = () => {
      processQueue()
        .then((result) => {
          if (result.submitted > 0 || result.failed > 0) {
            useEntryStore.getState().refreshLocal();
          }
        })
        .catch(() => {
          // queue handles its own errors per-entry
        });
    };

    const unsubConnectivity = addConnectivityListener((online) => {
      if (online) triggerSync();
    });

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refreshConnectivity().then((online) => {
          if (online) triggerSync();
        });
      }
    });

    triggerSync();

    let cancelled = false;
    (async () => {
      await loadReminderState();
      if (cancelled) return;
      await ensurePermissionRequestedOnce();
      await useReminderStore.getState().refreshPermission();
      if (cancelled) return;
      await rescheduleAllReminders();
    })();

    const responseSub = Notifications.addNotificationResponseReceivedListener(() => {
      router.replace('/');
    });

    const reminderRefreshSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        rescheduleAllReminders().catch(() => {
          // schedules can fail if permissions were revoked; safe to ignore
        });
      }
    });

    return () => {
      cancelled = true;
      unsubConnectivity();
      appStateSub.remove();
      stopConnectivityMonitor();
      responseSub.remove();
      reminderRefreshSub.remove();
    };
  }, [isAuthenticated, loadReminderState, router]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <ErrorBoundary>
      {!isReady ? (
        <View style={styles.splash}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: '600' },
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="entry/[projectId]" options={{ title: 'Select phase' }} />
          <Stack.Screen name="entry/hours" options={{ title: 'Log hours' }} />
          <Stack.Screen
            name="scan/processing"
            options={{ title: 'Processing', headerBackVisible: false }}
          />
          <Stack.Screen name="scan/review" options={{ title: 'Review entries' }} />
          <Stack.Screen
            name="auth/login"
            options={{ headerShown: false, gestureEnabled: false }}
          />
        </Stack>
      )}
      </ErrorBoundary>
      <Toast />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  splash: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
