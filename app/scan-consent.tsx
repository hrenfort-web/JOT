import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../theme';
import { useScanConsentStore } from '../store/useScanConsentStore';
import {
  SCAN_CONSENT_BODY,
  SCAN_CONSENT_CONTINUE_LABEL,
  SCAN_CONSENT_DONE_LABEL,
  SCAN_CONSENT_NOT_NOW_LABEL,
  SCAN_CONSENT_SETTINGS_LABEL,
  SCAN_CONSENT_TITLE,
} from '../utils/scanConsentCopy';

// Flat route (/scan-consent, not /scan/consent) for the same reason
// scan-processing and scan-review are flat: expo-router treats /scan/* as
// descendants of the /scan tab, which breaks dismissAll and tab focus (see
// the Phase 3i note in app/scan-review.tsx). Registered as a modal in
// app/_layout.tsx.
//
// Two modes via the `mode` route param:
//   gate — first-run consent. Continue records acceptance and replaces this
//          screen with the Scan tab; Not now marks the session as declined
//          and goes home. No header-left, no swipe-to-dismiss: the two
//          buttons are the only exits.
//   info — the Settings "How scanning works" view. Single Done button plus
//          a custom header-left close, owned by us rather than the native
//          back affordance (same reasoning as scan-review's CustomBackButton
//          on iOS 26 native-stack).
type Mode = 'gate' | 'info';

function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Close"
      hitSlop={12}
      style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
    >
      <Ionicons name="close" size={20} color={colors.text} />
    </Pressable>
  );
}

export default function ScanConsentScreen() {
  const router = useRouter();
  const { mode: rawMode } = useLocalSearchParams<{ mode?: string }>();
  const mode: Mode = rawMode === 'info' ? 'info' : 'gate';

  const accept = useScanConsentStore((s) => s.accept);
  const decline = useScanConsentStore((s) => s.decline);
  const [busy, setBusy] = useState(false);

  const onContinue = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await accept();
    } finally {
      setBusy(false);
    }
    // Replace this modal with the Scan tab; the tab re-renders with the
    // accepted flag and opens the camera.
    router.replace('/scan');
  }, [accept, busy, router]);

  const onNotNow = useCallback(() => {
    decline();
    router.replace('/');
  }, [decline, router]);

  const onDone = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, [router]);

  const screenOptions = useMemo(
    () => ({
      title: SCAN_CONSENT_SETTINGS_LABEL,
      headerLeft: mode === 'info' ? () => <CloseButton onPress={onDone} /> : () => null,
    }),
    [mode, onDone],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={screenOptions} />

      {/*
        Reading order for VoiceOver is the element order: title (a header),
        body, then the buttons. Nothing is absolutely positioned and no
        element sets accessibilityElementsHidden, so the screen reader
        walks it top to bottom.
      */}
      <ScrollView contentContainerStyle={styles.scroll} alwaysBounceVertical={false}>
        <View style={styles.iconWrap} accessible={false} importantForAccessibility="no">
          <Ionicons name="sparkles-outline" size={32} color={colors.accent} />
        </View>
        <Text style={styles.title} accessibilityRole="header">
          {SCAN_CONSENT_TITLE}
        </Text>
        <Text style={styles.body}>{SCAN_CONSENT_BODY}</Text>
      </ScrollView>

      <View style={styles.actions}>
        {mode === 'gate' ? (
          <>
            <Pressable
              onPress={onContinue}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={SCAN_CONSENT_CONTINUE_LABEL}
              accessibilityState={{ disabled: busy }}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && !busy && styles.primaryBtnPressed,
                busy && styles.btnDisabled,
              ]}
            >
              <Text style={styles.primaryBtnText}>{SCAN_CONSENT_CONTINUE_LABEL}</Text>
            </Pressable>
            <Pressable
              onPress={onNotNow}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={SCAN_CONSENT_NOT_NOW_LABEL}
              accessibilityState={{ disabled: busy }}
              style={({ pressed }) => [
                styles.secondaryBtn,
                pressed && !busy && styles.secondaryBtnPressed,
              ]}
            >
              <Text style={styles.secondaryBtnText}>{SCAN_CONSENT_NOT_NOW_LABEL}</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel={SCAN_CONSENT_DONE_LABEL}
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
          >
            <Text style={styles.primaryBtnText}>{SCAN_CONSENT_DONE_LABEL}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 16,
    gap: 16,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '500',
    color: colors.text,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textSecondary,
  },
  actions: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 10,
  },
  // Same pill geometry as the login / hours submit / scan permission
  // buttons: 56px tall, radius = height/2, accent fill, cream text.
  primaryBtn: {
    backgroundColor: colors.accent,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnPressed: {
    backgroundColor: colors.accentPressed,
  },
  primaryBtnText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '500',
  },
  secondaryBtn: {
    height: 48,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnPressed: {
    backgroundColor: colors.accentTint,
  },
  secondaryBtnText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  // Header-left close: same 32px circular Theme B surface as
  // HeaderHomeButton so the modal's chrome matches the entry flow.
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  closeButtonPressed: {
    backgroundColor: colors.accentTint,
  },
});
