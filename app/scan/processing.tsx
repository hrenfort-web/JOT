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
import { buildProjectLookup } from '../../services/ai/matcher';
import { parseTimesheetImage } from '../../services/ai/scanner';
import { logError } from '../../services/errors';

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
      setError('No projects found locally — sync with BQE Core first.');
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let cancelled = false;

    (async () => {
      try {
        const lookup = buildProjectLookup(flatProjects);
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
  }, [captured, flatProjects, router, setParsed]);

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
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed]}
            >
              <Text style={styles.primaryBtnText}>Try again</Text>
            </Pressable>
            <Pressable
              onPress={onEnterManually}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.btnPressed]}
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
    color: colors.muted,
    fontWeight: '500',
  },
  stepTextActive: {
    color: colors.text,
    fontWeight: '600',
  },
  stepTextComplete: {
    color: colors.text,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleError: {
    backgroundColor: '#FEE2E2',
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  actions: {
    gap: 10,
    width: '100%',
    maxWidth: 280,
    marginTop: 12,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  btnPressed: {
    opacity: 0.85,
  },
});
