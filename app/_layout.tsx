import { useEffect, useRef } from 'react';
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
import { installLogCapture } from '../utils/logBuffer';
import { prewarmBqeConnection } from '../services/bqe/prewarm';

// Foreground-prewarm threshold. If the app was backgrounded for at least
// this many ms before returning to active, fire a prewarm to refresh
// network state (TLS sockets get GC'd, tokens may have expired in the
// background). Shorter background gaps don't usually need it — the user
// briefly switched apps and the connection is still warm.
const FOREGROUND_PREWARM_THRESHOLD_MS = 5 * 60 * 1000;

// Install at module load (runs once when the JS bundle boots). Doing it here
// rather than inside the RootLayout component guarantees we capture even the
// very early console output that fires before React mounts — useful when
// debugging a production launch crash via the in-app log viewer.
installLogCapture();

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

  // Track when the app last LEFT active state (became background/inactive)
  // so the AppState listener below can decide whether a re-entry warrants
  // a prewarm. Lives in a ref so updates don't trigger re-renders.
  const wentBackgroundAtRef = useRef<number | null>(null);

  useEffect(() => {
    console.warn('[jot:bootstrap] hot reload smoke test — ' + Date.now());
    // First line in the effect, unconditional — confirms the effect runs
    // at all. If we're chasing a "prewarm never fires" bug and this line
    // doesn't appear in the log, the bug is in React/expo-router, not in
    // any of the code below.
    console.log('[jot:bootstrap] useEffect fired');
    (async () => {
      console.log('[jot:bootstrap] entering launch IIFE');
      try {
        await useAuthStore.getState().loadStoredTokens();
      } catch (e) {
        console.warn(
          '[jot:bootstrap] loadStoredTokens THREW (unexpected — it normally swallows internally):',
          e instanceof Error ? e.message : e,
        );
        // Don't return — we still want to render the app (the
        // protected-route effect will bounce to /auth/login). Just skip
        // prewarm since the auth state is uncertain.
        return;
      }
      const authed = useAuthStore.getState().isAuthenticated;
      console.log(
        `[jot:bootstrap] loadStoredTokens resolved, isAuthenticated=${authed}`,
      );
      if (authed) {
        console.log('[jot:bootstrap] calling prewarmBqeConnection');
        prewarmBqeConnection().catch(() => {
          // prewarm swallows its own errors internally — this catch
          // covers any synchronous throw before the first await inside.
        });
      } else {
        console.log('[jot:bootstrap] skipping prewarm — not authenticated');
      }
    })();
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
        // Foreground prewarm: only if the app spent >5min in the
        // background. Brief context-switches (e.g. user pulled down
        // Control Center for 3 seconds) don't need it, and we'd otherwise
        // waste a refresh + GET on every quick toggle.
        const backgroundedAt = wentBackgroundAtRef.current;
        if (
          backgroundedAt !== null &&
          Date.now() - backgroundedAt > FOREGROUND_PREWARM_THRESHOLD_MS
        ) {
          prewarmBqeConnection().catch(() => undefined);
        }
        wentBackgroundAtRef.current = null;

        refreshConnectivity().then((online) => {
          if (online) triggerSync();
        });
      } else if (state === 'background' || state === 'inactive') {
        // Snapshot when we left active. Next 'active' transition compares
        // against this to decide whether to prewarm.
        wentBackgroundAtRef.current = Date.now();
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
            headerBackTitle: '',
            headerBackButtonDisplayMode: 'minimal',
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen
            name="(tabs)"
            options={{
              headerShown: false,
              title: '',
              headerBackTitle: '',
              headerBackButtonDisplayMode: 'minimal',
            }}
          />
          <Stack.Screen
            name="entry/picker"
            options={{
              title: 'Pick a project',
              headerBackTitle: '',
              headerBackButtonDisplayMode: 'minimal',
            }}
          />
          <Stack.Screen
            name="entry/[projectId]"
            options={{
              title: 'Select phase',
              headerBackTitle: '',
              headerBackButtonDisplayMode: 'minimal',
            }}
          />
          <Stack.Screen
            name="entry/hours"
            options={{
              title: 'Log hours',
              headerBackTitle: '',
              headerBackButtonDisplayMode: 'minimal',
            }}
          />
          <Stack.Screen
            name="scan/processing"
            options={{
              title: 'Processing',
              headerBackVisible: false,
              headerBackTitle: '',
              headerBackButtonDisplayMode: 'minimal',
            }}
          />
          <Stack.Screen
            name="scan/review"
            options={{
              title: 'Review entries',
              headerBackTitle: '',
              headerBackButtonDisplayMode: 'minimal',
            }}
          />
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
