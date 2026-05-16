import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { colors } from '../theme';
import { PROJECT_COLORS } from '../utils/projectColors';

// ---------------------------------------------------------------------------
// SubmitWeekCelebration — full-screen success overlay shown when Submit Week
// fully succeeds (every entry accepted by the backend). Fires from
// app/(tabs)/index.tsx's handleSubmitWeek on `result.ok && failedCount === 0`.
//
// Animation layout (all measured from t=0 = visible flips true):
//   t=0      cream scrim fades in (150ms)
//   t=150    short checkmark stroke draws via scaleX 0→1 (250ms, easeOut quad)
//   t=350    long checkmark stroke draws via scaleX 0→1 (550ms, easeOut cubic)
//              ↑ 50ms overlap with short stroke so the V-bottom feels continuous
//   t=900    8 confetti pieces spawn behind the check, stagger 30ms, animate
//              1200ms each (X spread + Y fall + rotation, opacity fades final 20%)
//   t=2310   confetti settled (last piece + stagger)
//   t=~2510  hold 200ms beyond last piece
//   t=~2810  overall opacity fades to 0 (300ms), onDismiss called
//
// Reduce-motion fallback: skips the stroke animation and confetti entirely.
// Static checkmark (both strokes at scaleX=1 from the start), scrim+check
// fade in over 200ms, hold 1100ms, fade out over 200ms. Total ~1.5s.
// VoiceOver announcement fires regardless of motion preference.
//
// Tap anywhere during the sequence to dismiss early — running animations
// stop, overall opacity fades over 200ms, onDismiss fires once.
//
// Built on react-native Animated + View primitives only. No SVG, no new deps.
// The "stroke draws on" effect is achieved by composing each leg of the
// checkmark from a horizontal rectangle with `transformOrigin` set to the
// pivot edge (V-bottom corner) and animating scaleX 0→1 — the rectangle
// expands outward from the V-bottom along its rotated long axis.
// ---------------------------------------------------------------------------

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Checkmark geometry — designed in a 100×100 logical box, rendered 1.2× larger.
const SCALE = 1.2;
// Stroke 1 (short): (25,50) → (45,70). Length = √800 ≈ 28.284. Angle +45°.
// Stroke 2 (long):  (45,70) → (80,30). Length = √2825 ≈ 53.150. Angle from
// horizontal = -atan2(40, 35) ≈ -48.81° (negative because dy<0 in screen-down).
const SHORT_LENGTH = Math.hypot(20, 20) * SCALE;
const LONG_LENGTH = Math.hypot(35, 40) * SCALE;
const STROKE_HEIGHT = 7;
const SHORT_ANGLE_DEG = 45;
const LONG_ANGLE_DEG = -(Math.atan2(40, 35) * 180) / Math.PI;
// V-bottom pivot in container coords (100×100 logical box scaled by SCALE).
const PIVOT_X = 45 * SCALE;
const PIVOT_Y = 70 * SCALE;
const CONTAINER_SIZE = 100 * SCALE;

// Confetti config.
const CONFETTI_COUNT = 8;
const CONFETTI_W = 8;
const CONFETTI_H = 16;
const CONFETTI_DURATION = 1200;
const CONFETTI_STAGGER = 30;

interface ConfettiConfig {
  color: string;
  destX: number;
  destY: number;
  rotationDeg: number;
}

function makeConfettiConfigs(): ConfettiConfig[] {
  const out: ConfettiConfig[] = [];
  for (let i = 0; i < CONFETTI_COUNT; i += 1) {
    // X spread: ±screenWidth/3, biased outward (avoid clustering at center).
    const sign = Math.random() < 0.5 ? -1 : 1;
    const destX = sign * (SCREEN_WIDTH / 6 + Math.random() * (SCREEN_WIDTH / 6));
    // Y fall: 80–110% of screen height so pieces leave the viewport bottom.
    const destY = SCREEN_HEIGHT * (0.8 + Math.random() * 0.3);
    // Rotation: [-720°, +720°] — two full spins in either direction.
    const rotationDeg = (Math.random() - 0.5) * 1440;
    const color = PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)];
    out.push({ color, destX, destY, rotationDeg });
  }
  return out;
}

interface ConfettiRefs {
  x: Animated.Value;
  y: Animated.Value;
  rotate: Animated.Value;
  opacity: Animated.Value;
}

function makeConfettiRefs(): ConfettiRefs[] {
  return Array.from({ length: CONFETTI_COUNT }, () => ({
    x: new Animated.Value(0),
    y: new Animated.Value(0),
    rotate: new Animated.Value(0),
    opacity: new Animated.Value(1),
  }));
}

interface SubmitWeekCelebrationProps {
  visible: boolean;
  onDismiss: () => void;
}

export function SubmitWeekCelebration({
  visible,
  onDismiss,
}: SubmitWeekCelebrationProps) {
  // Animated values. Created once on mount; reset before each play via
  // `.setValue()`. Holding them in refs keeps identity stable across renders
  // so the JSX bindings don't churn.
  const scrimOpacity = useRef(new Animated.Value(0)).current;
  const overallOpacity = useRef(new Animated.Value(1)).current;
  const shortScale = useRef(new Animated.Value(0)).current;
  const longScale = useRef(new Animated.Value(0)).current;

  // Confetti configs + animated values, generated once on mount. The configs
  // randomize per-instance — if the user submits two weeks in a row, the
  // second celebration will have different confetti trajectories.
  const confettiConfigsRef = useRef<ConfettiConfig[] | null>(null);
  const confettiRefsRef = useRef<ConfettiRefs[] | null>(null);
  if (confettiConfigsRef.current === null) {
    confettiConfigsRef.current = makeConfettiConfigs();
  }
  if (confettiRefsRef.current === null) {
    confettiRefsRef.current = makeConfettiRefs();
  }

  // Reduce motion preference. Queried once on mount; iOS toggles this in
  // Settings → Accessibility → Motion, Android in Settings → Accessibility
  // → Remove animations. RN's AccessibilityInfo abstracts both.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => undefined);
  }, []);

  // Running composite animation, so tap-to-dismiss can stop it.
  const runningRef = useRef<Animated.CompositeAnimation | null>(null);
  // Guard against double-dismiss (auto-completion + user tap, or rapid taps).
  const dismissedRef = useRef(false);

  // Drive the sequence whenever `visible` flips true. Reset state on each
  // play so the component can be re-shown (e.g., user submits two weeks
  // in the same session).
  useEffect(() => {
    if (!visible) {
      // Reset for next play.
      dismissedRef.current = false;
      return;
    }
    dismissedRef.current = false;

    // Reset animated values.
    scrimOpacity.setValue(0);
    overallOpacity.setValue(1);
    shortScale.setValue(reduceMotion ? 1 : 0);
    longScale.setValue(reduceMotion ? 1 : 0);
    const cRefs = confettiRefsRef.current;
    if (cRefs !== null) {
      cRefs.forEach((r) => {
        r.x.setValue(0);
        r.y.setValue(0);
        r.rotate.setValue(0);
        r.opacity.setValue(1);
      });
    }

    // Screen-reader announcement fires on both motion paths.
    AccessibilityInfo.announceForAccessibility('Week submitted!');

    const handleAutoComplete = (result: Animated.EndResult) => {
      if (result.finished && !dismissedRef.current) {
        dismissedRef.current = true;
        onDismiss();
      }
    };

    if (reduceMotion) {
      // Static fallback — no stroke draw, no confetti. Just a calm fade.
      const seq = Animated.sequence([
        Animated.timing(scrimOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.delay(1100),
        Animated.timing(overallOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]);
      runningRef.current = seq;
      seq.start(handleAutoComplete);
      return;
    }

    // Full motion sequence.
    const configs = confettiConfigsRef.current ?? [];
    const refs = confettiRefsRef.current ?? [];
    const confettiAnimations = configs.map((config, i) => {
      const r = refs[i];
      return Animated.parallel([
        Animated.timing(r.x, {
          toValue: config.destX,
          duration: CONFETTI_DURATION,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(r.y, {
          toValue: config.destY,
          duration: CONFETTI_DURATION,
          // Easing.in approximates gravity acceleration on the fall.
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(r.rotate, {
          toValue: 1,
          duration: CONFETTI_DURATION,
          useNativeDriver: true,
        }),
        // Opacity holds at 1 for 80% of the duration, fades to 0 in the
        // final 20%. Composed as sequence(delay, timing) so the fade
        // segment only runs at the tail.
        Animated.sequence([
          Animated.delay(CONFETTI_DURATION * 0.8),
          Animated.timing(r.opacity, {
            toValue: 0,
            duration: CONFETTI_DURATION * 0.2,
            useNativeDriver: true,
          }),
        ]),
      ]);
    });

    const seq = Animated.sequence([
      // 1. Scrim fade in.
      Animated.timing(scrimOpacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }),
      // 2. Checkmark draw. Short stroke first; long stroke starts 200ms
      // later (50ms before short ends) so the V-bottom transition reads
      // as continuous motion rather than two discrete events.
      Animated.parallel([
        Animated.timing(shortScale, {
          toValue: 1,
          duration: 250,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.delay(200),
          Animated.timing(longScale, {
            toValue: 1,
            duration: 550,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ]),
      // 3. Confetti spawn (stagger).
      Animated.stagger(CONFETTI_STAGGER, confettiAnimations),
      // 4. Brief hold so the eye settles on the completed check before fade.
      Animated.delay(200),
      // 5. Fade everything out.
      Animated.timing(overallOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]);

    runningRef.current = seq;
    seq.start(handleAutoComplete);

    return () => {
      // Cleanup if visible flips false externally (e.g., parent unmounts).
      runningRef.current?.stop();
    };
  }, [visible, reduceMotion, scrimOpacity, overallOpacity, shortScale, longScale, onDismiss]);

  const handleTapDismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    runningRef.current?.stop();
    // Quick fade out (shorter than the auto-completion fade), then dismiss.
    Animated.timing(overallOpacity, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      onDismiss();
    });
  };

  if (!visible) return null;

  const configs = confettiConfigsRef.current ?? [];
  const refs = confettiRefsRef.current ?? [];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleTapDismiss}
      // accessibilityViewIsModal traps screen-reader focus inside the modal
      // while it's up — paired with the announceForAccessibility call so the
      // success message is read instead of whatever was behind the overlay.
      accessibilityViewIsModal
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handleTapDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss celebration"
      >
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.root, { opacity: overallOpacity }]}
        >
          {/* Cream scrim. Backed by rgba so opacity animated 0→1 lands at the
              design value of 0.55. */}
          <Animated.View
            style={[styles.scrim, { opacity: scrimOpacity }]}
            pointerEvents="none"
          />
          {/* Centered stage. Confetti renders BEHIND the check (rendered
              first) so the check is always the foreground anchor. */}
          <View style={styles.stage} pointerEvents="none">
            {/* Confetti layer */}
            {configs.map((config, i) => {
              const r = refs[i];
              const rotateInterp = r.rotate.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', `${config.rotationDeg}deg`],
              });
              return (
                <Animated.View
                  key={i}
                  style={[
                    styles.confettiPiece,
                    {
                      backgroundColor: config.color,
                      opacity: r.opacity,
                      transform: [
                        { translateX: r.x },
                        { translateY: r.y },
                        { rotate: rotateInterp },
                      ],
                    },
                  ]}
                />
              );
            })}
            {/* Checkmark layer */}
            <View style={styles.checkContainer}>
              {/* Short stroke. transformOrigin '100% 50%' pins the pivot to
                  the rectangle's right edge, which after positioning sits at
                  the V-bottom point. scaleX 0→1 grows the stroke outward
                  from that pivot back along its rotated long axis. */}
              <Animated.View
                style={[
                  styles.stroke,
                  {
                    left: PIVOT_X - SHORT_LENGTH,
                    top: PIVOT_Y - STROKE_HEIGHT / 2,
                    width: SHORT_LENGTH,
                    transformOrigin: '100% 50%',
                    transform: [
                      { scaleX: shortScale },
                      { rotate: `${SHORT_ANGLE_DEG}deg` },
                    ],
                  },
                ]}
              />
              {/* Long stroke. transformOrigin '0% 50%' pins the pivot to the
                  rectangle's left edge — same V-bottom point as the short
                  stroke. */}
              <Animated.View
                style={[
                  styles.stroke,
                  {
                    left: PIVOT_X,
                    top: PIVOT_Y - STROKE_HEIGHT / 2,
                    width: LONG_LENGTH,
                    transformOrigin: '0% 50%',
                    transform: [
                      { scaleX: longScale },
                      { rotate: `${LONG_ANGLE_DEG}deg` },
                    ],
                  },
                ]}
              />
            </View>
          </View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    // Cream paper (`colors.background` = '#FAF6EE') at 55% alpha. Hardcoded
    // here rather than via opacity-on-View because we want the SCRIM's
    // opacity animated independently of the overall fade-out.
    backgroundColor: 'rgba(250, 246, 238, 0.55)',
  },
  stage: {
    width: CONTAINER_SIZE,
    height: CONTAINER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkContainer: {
    width: CONTAINER_SIZE,
    height: CONTAINER_SIZE,
    position: 'absolute',
  },
  stroke: {
    position: 'absolute',
    height: STROKE_HEIGHT,
    backgroundColor: colors.accent,
    // Round the ends so the stroke caps approximate `strokeLinecap="round"`.
    borderRadius: STROKE_HEIGHT / 2,
  },
  confettiPiece: {
    position: 'absolute',
    width: CONFETTI_W,
    height: CONFETTI_H,
    borderRadius: 2,
  },
});
