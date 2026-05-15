import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../../theme';
import { useScanStore } from '../../store/useScanStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useAuthStore } from '../../store/useAuthStore';
import { buildScanLookup } from '../../services/ai/matcher';
import { parseTimesheetImage } from '../../services/ai/scanner';
import { loadLocalEntriesInRange } from '../../services/bqe/timeentry';
import { logError } from '../../services/errors';
import { DEFAULT_RECENT_DAYS } from '../../utils/projectSort';
import type { LocalTimeEntry } from '../../db/schema';

const STEPS = [
  'Reading your notes…',
  'Matching projects…',
  'Building your timesheet…',
] as const;

const STEP_TICK_MS = 1800;
const TIMEOUT_MS = 30_000;
const MIN_OVERALL_CONFIDENCE = 0.5;

export default function ProcessingScreen() {
  const router = useRouter();
  const captured = useScanStore((s) => s.captured);
  const setParsed = useScanStore((s) => s.setParsed);
  const flatProjects = useProjectStore((s) => s.flatProjects);
  const user = useAuthStore((s) => s.user);

  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  useEffect(() => {
    if (!captured) {
      router.replace('/scan');
      return;
    }
    if (flatProjects.length === 0) {
      setError('No projects found locally — sync first.');
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let cancelled = false;

    (async () => {
      try {
        // Load the user's recent entries so the scan lookup can filter
        // down to (recent ∪ overhead) instead of shipping every active
        // project firm-wide. ~50-200ms SQLite read on Studio G's data.
        // Empty/error → fall through with [] entries; buildScanLookup
        // still ships overhead-only, which is better than failing the
        // scan entirely.
        let recentEntries: LocalTimeEntry[] = [];
        if (user?.id) {
          const end = new Date();
          const start = new Date();
          start.setDate(end.getDate() - DEFAULT_RECENT_DAYS);
          try {
            recentEntries = await loadLocalEntriesInRange(user.id, start, end);
          } catch (loadErr) {
            console.warn(
              '[jot:scan-lookup] recent-entries load failed, falling back to overhead-only:',
              loadErr instanceof Error ? loadErr.message : loadErr,
            );
          }
        }

        const { lookup, debug } = buildScanLookup(
          flatProjects,
          recentEntries,
          user?.id ?? '',
        );
        console.log(
          `[jot:scan-lookup] filtered ${debug.finalParents} parents from ${debug.totalParents} total ` +
            `(recent=${debug.recentCount}, overhead=${debug.overheadCount}, capped=${debug.capped}), ` +
            `${debug.phaseCount} phases in prompt, ~${debug.estimatedTokens} tokens estimated`,
        );

        const parsed = await parseTimesheetImage(captured.base64, lookup, {
          signal: controller.signal,
        });
        if (cancelled) return;

        if (parsed.entries.length === 0) {
          setError("Couldn't find any time entries in this image.");
          return;
        }
        if (parsed.overallConfidence < MIN_OVERALL_CONFIDENCE) {
          setError('Image too blurry — try again with a clearer photo.');
          return;
        }

        setParsed(parsed);
        setStepIndex(STEPS.length - 1);
        setDone(true);
        setTimeout(() => {
          if (!cancelled) router.replace('/scan/review');
        }, 250);
      } catch (e) {
        if (cancelled) return;
        logError('scan.process', e);
        if ((e as Error).name === 'AbortError') {
          setError('Processing took too long. Try again or enter manually.');
        } else {
          setError(
            "We couldn't read this image. Try a clearer photo, or enter your hours manually.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, [captured, flatProjects, router, setParsed, user?.id]);

  useEffect(() => {
    if (error || done) return;
    if (stepIndex >= STEPS.length - 1) return;
    const t = setTimeout(() => setStepIndex((s) => Math.min(s + 1, STEPS.length - 1)), STEP_TICK_MS);
    return () => clearTimeout(t);
  }, [stepIndex, error, done]);

  const onTryAgain = () => {
    router.replace('/scan');
  };

  const onEnterManually = () => {
    if (router.canDismiss?.()) {
      router.dismissAll();
    } else {
      router.replace('/');
    }
  };

  const rotation = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen
          options={{
            title: 'Scan failed',
            headerBackVisible: true,
            headerBackTitle: '',
            headerBackButtonDisplayMode: 'minimal',
          }}
        />
        <View style={styles.content}>
          <View style={[styles.iconCircle, styles.iconCircleError]}>
            <Ionicons name="alert-circle-outline" size={36} color={colors.danger} />
          </View>
          <Text style={styles.errorTitle}>Couldn't read this image</Text>
          <Text style={styles.errorBody}>{error}</Text>

          <View style={styles.actions}>
            <Pressable
              onPress={onTryAgain}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.primaryBtnPressed,
              ]}
            >
              <Text style={styles.primaryBtnText}>Try again</Text>
            </Pressable>
            <Pressable
              onPress={onEnterManually}
              style={({ pressed }) => [
                styles.secondaryBtn,
                pressed && styles.secondaryBtnPressed,
              ]}
            >
              <Text style={styles.secondaryBtnText}>Enter manually</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Processing',
          headerBackVisible: false,
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      <View style={styles.content}>
        <View style={styles.spinnerWrap}>
          <Animated.View style={{ transform: [{ rotate: rotation }] }}>
            <View style={styles.spinnerRing} />
          </Animated.View>
          <ActivityIndicator
            color={colors.accent}
            size="large"
            style={styles.spinnerInner}
          />
        </View>

        <View style={styles.steps}>
          {STEPS.map((label, i) => {
            const isActive = i === stepIndex && !done;
            const isComplete = i < stepIndex || done;
            return (
              <View key={label} style={styles.stepRow}>
                {isComplete ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
                ) : isActive ? (
                  <View style={styles.stepDotActive} />
                ) : (
                  <View style={styles.stepDotIdle} />
                )}
                <Text
                  style={[
                    styles.stepText,
                    isComplete && styles.stepTextComplete,
                    isActive && styles.stepTextActive,
                  ]}
                >
                  {label}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 24,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 32,
  },
  spinnerWrap: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinnerRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 4,
    borderColor: colors.accentTint,
    borderTopColor: colors.accent,
  },
  spinnerInner: {
    position: 'absolute',
  },
  steps: {
    alignItems: 'flex-start',
    gap: 14,
    minWidth: 240,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  // Step indicators: idle (upcoming) is the most muted, active is the
  // accent moment, complete sits between — visible but no longer the
  // focus of attention.
  stepDotIdle: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.border,
  },
  stepDotActive: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
  stepText: {
    fontSize: 15,
    color: colors.textTertiary,
    fontWeight: '400',
  },
  stepTextActive: {
    color: colors.accent,
    fontWeight: '500',
  },
  stepTextComplete: {
    color: colors.textSecondary,
    fontWeight: '400',
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleError: {
    backgroundColor: colors.dangerTint,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '500',
    color: colors.text,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  actions: {
    gap: 10,
    width: '100%',
    maxWidth: 280,
    marginTop: 12,
  },
  // Primary "Try again" — same pill geometry as login/hours submit.
  primaryBtn: {
    backgroundColor: colors.accent,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '500',
  },
  // Secondary "Enter manually" — outlined, lower weight.
  secondaryBtn: {
    height: 48,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  // Primary pressed: shift to the darker accent (accentPressed). Matches
  // login + hours submit.
  primaryBtnPressed: {
    backgroundColor: colors.accentPressed,
  },
  // Secondary pressed: subtle accent-muted wash on the cream surface.
  secondaryBtnPressed: {
    backgroundColor: colors.accentTint,
  },
});
