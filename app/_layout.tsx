import { useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, AppState, StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ArchitectsDaughter_400Regular,
  useFonts,
} from '@expo-google-fonts/architects-daughter';
import * as SplashScreen from 'expo-splash-screen';
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
import { useSyncStore } from '../store/useSyncStore';
import { installLogCapture } from '../utils/logBuffer';
import { prewarmBqeConnection } from '../services/bqe/prewarm';

// Keep the native splash up until the JS side signals it's ready (font
// loaded + auth state hydrated). Called at module load — must run before
// the first render. We call it inside a try/catch because Expo's docs
// note repeat calls can throw on some platforms.
SplashScreen.preventAutoHideAsync().catch(() => {
  // No-op: the splash will hide on its default timer if this fails.
  // We'd rather degrade to a flash of the wrong colour than crash.
});

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

// ─── Hoisted navigator + screen options ──────────────────────────────
// Hypothesis: expo-router was rebuilding navigation state at sync
// completion because RootLayout's inline `<Stack screenOptions={{...}}>`
// and `<Stack.Screen options={{...}}>` JSX produced fresh object
// references on every render. When useSegments ticks a re-render of
// RootLayout, the Stack receives "new" options and may pop the active
// pushed screen. Lifting these to module-scope constants gives every
// re-render of RootLayout the SAME identity-stable references to pass
// down, eliminating the reference-churn trigger.

const STACK_SCREEN_OPTIONS = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: '600' as const },
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
  contentStyle: { backgroundColor: colors.background },
};

const SCREEN_OPTIONS_TABS = {
  headerShown: false,
  title: '',
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
};

const SCREEN_OPTIONS_ENTRY_PICKER = {
  title: 'Pick a project',
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
};

const SCREEN_OPTIONS_ENTRY_PROJECT_ID = {
  title: 'Select phase',
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
};

const SCREEN_OPTIONS_ENTRY_HOURS = {
  title: 'Log hours',
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
};

const SCREEN_OPTIONS_SCAN_PROCESSING = {
  title: 'Processing',
  headerBackVisible: false,
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
};

const SCREEN_OPTIONS_SCAN_REVIEW = {
  title: 'Review entries',
  headerBackTitle: '',
  headerBackButtonDisplayMode: 'minimal' as const,
};

const SCREEN_OPTIONS_AUTH_LOGIN = { headerShown: false, gestureEnabled: false };
// ─────────────────────────────────────────────────────────────────────

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
  const demoMode = useAuthStore((s) => s.demoMode);
  const loadStoredTokens = useAuthStore((s) => s.loadStoredTokens);
  const loadReminderState = useReminderStore((s) => s.load);

  // Architects Daughter for the "Jot it." wordmark + the home greeting.
  // Render gate: nothing in the tree can render until this resolves.
  // Otherwise the first paint shows the wordmark in a system font then
  // reflows when the font arrives — visible flicker on cold launch.
  const [fontsLoaded, fontError] = useFonts({
    ArchitectsDaughter_400Regular,
  });

  // Hide the native splash once the font is loaded (or has explicitly
  // failed — better to show the app in a fallback than hang). useAuthStore
  // isReady is handled by the existing splash-loading View further down,
  // so we don't need to wait for it here.
  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [fontsLoaded, fontError]);

  // Track when the app last LEFT active state (became background/inactive)
  // so the AppState listener below can decide whether a re-entry warrants
  // a prewarm. Lives in a ref so updates don't trigger re-renders.
  const wentBackgroundAtRef = useRef<number | null>(null);

  // The last notification-response identifier we acted on. Expo replays
  // pending responses when its listener is (re-)registered, so without
  // dedupe a single tap can fire router.replace('/') more than once —
  // dragging the user away from whatever screen they were on. See the
  // listener below for the full filter chain.
  const lastHandledNotifIdRef = useRef<string | null>(null);

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

    // Hardened notification-response listener.
    //
    // The previous version was a one-liner: `() => router.replace('/')`.
    // It caused at least one in-the-wild bug where users mid-task on the
    // hour-entry screen were yanked back to home — diagnosis was that this
    // listener was firing for non-tap responses (dismissals/swipes) AND
    // re-firing for replayed responses when expo-notifications re-registered
    // the listener on effect re-runs.
    //
    // Three guards:
    //   1. actionIdentifier filter — only act on actual taps. A dismissal
    //      (user swipes the banner away) reports a different identifier and
    //      should NOT navigate.
    //   2. Identifier dedupe — store the last-acted-on notification id in a
    //      ref. If Expo replays the same response, drop it.
    //   3. Honour data.route from the notification payload — each scheduled
    //      reminder ships `data: { route: '/' }`; we read it explicitly so
    //      future notifications can deep-link elsewhere without revisiting
    //      this listener. Falls back to '/' on missing/malformed values.
    //
    // The console.logs route through installLogCapture() and end up in the
    // Debug → Logs viewer, so we can audit dropped events on device.
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
          console.log(
            '[jot:notif] dropping non-tap response',
            response.actionIdentifier,
          );
          return;
        }

        const id = response.notification.request.identifier;
        if (lastHandledNotifIdRef.current === id) {
          console.log('[jot:notif] dropping replayed response', id);
          return;
        }
        lastHandledNotifIdRef.current = id;

        const data = response.notification.request.content.data as
          | { route?: string }
          | undefined;
        const route =
          typeof data?.route === 'string' && data.route.startsWith('/')
            ? data.route
            : '/';

        console.log('[jot:notif] handling tap, routing to', route);
        router.replace(route);
      },
    );

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

  // Post-auth sync trigger. Replaces the cache-empty branch in HomeScreen's
  // bootstrap useEffect (gone in Commit 2 of the Path A refactor). Fires
  // whenever (isReady && isAuthenticated && !demoMode) becomes true — so on
  // cold launch with stored tokens AND immediately after a fresh login. The
  // sync store's single-flight gate (returns the existing in-flight promise
  // on re-entry) prevents the brief overlap with login()'s direct
  // runInitialSync call from doubling work; that direct call is removed in
  // Commit 3 and the bounded-duplication window closes.
  //
  // Fire-and-forget. Errors land in useSyncStore.lastError; the home screen
  // shows them via its existing error rendering path.
  useEffect(() => {
    if (!isReady) return;
    if (!isAuthenticated) return;
    if (demoMode) return;
    useSyncStore.getState().runSync('cold-launch');
  }, [isReady, isAuthenticated, demoMode]);

  // Combined readiness: both fonts AND auth state must be hydrated before
  // we let the route tree mount. If fonts fail to load (fontError set),
  // we still proceed — a fallback system font is preferable to a hung
  // splash screen.
  const ready = isReady && (fontsLoaded || !!fontError);

  // Stack children — memoized array of <Stack.Screen> elements. The
  // earlier shape wrapped the screens in a React.Fragment, which
  // expo-router's <Stack> layout walker treats as a single non-Screen
  // child (firing the "Layout children must be of type Screen" warn
  // on every render) and tearing down the route registry whenever
  // the children prop ref changed — which was every render. The
  // memoized array with empty deps gives expo-router (a) only valid
  // Stack.Screen elements as direct children and (b) a stable
  // reference across renders so reconciliation matches by key
  // instead of rebuilding. The bounce-on-sync-completion remount of
  // (tabs) is the symptom this addresses.
  const stackChildren = useMemo(
    () => [
      <Stack.Screen key="tabs" name="(tabs)" options={SCREEN_OPTIONS_TABS} />,
      <Stack.Screen
        key="entry/picker"
        name="entry/picker"
        options={SCREEN_OPTIONS_ENTRY_PICKER}
      />,
      <Stack.Screen
        key="entry/[projectId]"
        name="entry/[projectId]"
        options={SCREEN_OPTIONS_ENTRY_PROJECT_ID}
      />,
      <Stack.Screen
        key="entry/hours"
        name="entry/hours"
        options={SCREEN_OPTIONS_ENTRY_HOURS}
      />,
      <Stack.Screen
        key="scan/processing"
        name="scan/processing"
        options={SCREEN_OPTIONS_SCAN_PROCESSING}
      />,
      <Stack.Screen
        key="scan/review"
        name="scan/review"
        options={SCREEN_OPTIONS_SCAN_REVIEW}
      />,
      <Stack.Screen
        key="auth/login"
        name="auth/login"
        options={SCREEN_OPTIONS_AUTH_LOGIN}
      />,
    ],
    [],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <ErrorBoundary>
      {!ready ? (
        <View style={styles.splash}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <Stack screenOptions={STACK_SCREEN_OPTIONS}>
          {stackChildren}
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
