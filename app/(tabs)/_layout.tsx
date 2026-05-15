import { useMemo } from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme';

// ─── Hoisted navigator + screen options ──────────────────────────────
// Same rationale as in app/_layout.tsx: stable references for every
// option object and every callback prop, so re-renders of TabLayout
// don't trigger expo-router/react-navigation to think the screen
// configuration changed.

interface TabBarIconProps {
  color: string;
  size: number;
  focused: boolean;
}

const renderHomeIcon = ({ color, size }: TabBarIconProps) => (
  <Ionicons name="home-outline" size={size} color={color} />
);
const renderScanIcon = ({ color, size }: TabBarIconProps) => (
  <Ionicons name="camera-outline" size={size} color={color} />
);
const renderSettingsIcon = ({ color, size }: TabBarIconProps) => (
  <Ionicons name="settings-outline" size={size} color={color} />
);

const TABS_SCREEN_OPTIONS = {
  // Theme B: active = accent (burnt orange), inactive = textTertiary
  // (the same muted #8A877F used everywhere else for "data not yet
  // present" / disabled-label states). Tab bar background is the
  // cream surface so it sits half a tone above the page background
  // — keeps the tab strip felt without a hard border.
  tabBarActiveTintColor: colors.accent,
  tabBarInactiveTintColor: colors.textTertiary,
  tabBarStyle: {
    backgroundColor: colors.surface,
    borderTopColor: colors.borderSubtle,
  },
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: '500' as const },
};

const SCREEN_OPTIONS_TAB_INDEX = {
  title: 'Home',
  headerShown: false,
  tabBarIcon: renderHomeIcon,
};

const SCREEN_OPTIONS_TAB_SCAN = {
  title: 'Scan',
  headerShown: false,
  tabBarIcon: renderScanIcon,
};

const SCREEN_OPTIONS_TAB_SETTINGS = {
  title: 'Settings',
  tabBarIcon: renderSettingsIcon,
};
// ─────────────────────────────────────────────────────────────────────

export default function TabLayout() {
  // Memoized Tabs.Screen children — same pattern as RootLayout's
  // stackChildren. Without memoization each Tabs.Screen element is
  // fresh JSX on every render of TabLayout, which gives the inner
  // tab navigator reconciler a new children array to walk every
  // time. Stable array + explicit keys keep the route registry
  // pinned across re-renders. Empty deps because the options are
  // all module-scope constants.
  const tabScreens = useMemo(
    () => [
      <Tabs.Screen key="index" name="index" options={SCREEN_OPTIONS_TAB_INDEX} />,
      <Tabs.Screen key="scan" name="scan" options={SCREEN_OPTIONS_TAB_SCAN} />,
      <Tabs.Screen
        key="settings"
        name="settings"
        options={SCREEN_OPTIONS_TAB_SETTINGS}
      />,
    ],
    [],
  );

  return (
    <Tabs screenOptions={TABS_SCREEN_OPTIONS}>
      {tabScreens}
    </Tabs>
  );
}
