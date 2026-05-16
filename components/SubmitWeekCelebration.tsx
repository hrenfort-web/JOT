import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, FONT_HANDWRITING } from '../theme';
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

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// Checkmark geometry — designed in a 100×100 logical box, rendered 3.2× larger
// (320×320 stage). All derived constants below scale with SCALE so changing
// the stage size propagates cleanly.
const SCALE = 3.2;
// Stroke 1 (short): (25,50) → (45,70). Length = √800 ≈ 28.284. Angle +45°.
// Stroke 2 (long):  (45,70) → (80,30). Length = √2825 ≈ 53.150. Angle from
// horizontal = -atan2(40, 35) ≈ -48.81° (negative because dy<0 in screen-down).
const SHORT_LENGTH = Math.hypot(20, 20) * SCALE;
const LONG_LENGTH = Math.hypot(35, 40) * SCALE;
const STROKE_HEIGHT = 28;
const SHORT_ANGLE_DEG = 45;
const LONG_ANGLE_DEG = -(Math.atan2(40, 35) * 180) / Math.PI;
// V-bottom pivot in container coords (100×100 logical box scaled by SCALE).
const PIVOT_X = 45 * SCALE;
const PIVOT_Y = 70 * SCALE;
const CONTAINER_SIZE = 100 * SCALE;

// Confetti config — radial burst with gravity drift.
const CONFETTI_COUNT = 80;
const CONFETTI_W = 8;
const CONFETTI_H = 16;
const CONFETTI_DURATION = 1200;
// Per-piece random pre-delay window — gives the burst slight organic variance
// without the cascade feel of a Animated.stagger. Generated per play, not at
// module load, so the burst differs across consecutive submits.
const CONFETTI_MAX_RANDOM_DELAY = 50;

// Tagline ("DONE") layout. Positioned absolutely within the stage at
// PIVOT_Y + TAGLINE_OFFSET so the gap-below-check derives from the same
// pivot constant the strokes use.
const TAGLINE_TEXT = 'DONE';
const TAGLINE_FONT_SIZE = 56;
const TAGLINE_OFFSET = 60;

interface ConfettiConfig {
  color: string;
  destX: number;
  destY: number;
  rotationDeg: number;
}

// Radial burst trajectory model: each piece picks a random angle around the
// full circle and a random distance from origin, with a downward gravityBias
// added to destY. Result: destinations distributed in a circle around the
// spawn point, biased toward the lower half of the screen so the overall
// motion reads as a burst that drifts down rather than scattering uniformly.
// Pieces with angles in the upper half (sin(angle) < 0) appear to fly up
// before being pulled down by the bias; pieces in the lower half accelerate
// outward and down. With easeOut on both X and Y, pieces decelerate as they
// reach their destination, settling rather than skidding.
function makeConfettiConfigs(): ConfettiConfig[] {
  const out: ConfettiConfig[] = [];
  const gravityBias = SCREEN_HEIGHT * 0.3;
  for (let i = 0; i < CONFETTI_COUNT; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 200 + Math.random() * 300;
    const destX = Math.cos(angle) * distance;
    const destY = Math.sin(angle) * distance + gravityBias;
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
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const taglineScale = useRef(new Animated.Value(0.6)).current;

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

    // Reset animated values. In reduce-motion mode the check strokes and
    // tagline are pinned to their "complete" state up front so they appear
    // statically alongside the scrim fade-in (no per-element animation).
    scrimOpacity.setValue(0);
    overallOpacity.setValue(1);
    shortScale.setValue(reduceMotion ? 1 : 0);
    longScale.setValue(reduceMotion ? 1 : 0);
    taglineOpacity.setValue(reduceMotion ? 1 : 0);
    taglineScale.setValue(reduceMotion ? 1 : 0.6);
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
    // Each piece's animation: a tiny random pre-delay (0–50ms) for organic
    // burst variance, then a parallel of {translateX, translateY, rotation,
    // tail-only opacity fade}. All 40 pieces run as siblings of the tagline
    // animation inside a single outer Animated.parallel — they all start at
    // t=900 (right after the check completes) and the block resolves when
    // the longest child finishes.
    const confettiAnimations = configs.map((config, i) => {
      const r = refs[i];
      const randomDelay = Math.random() * CONFETTI_MAX_RANDOM_DELAY;
      return Animated.sequence([
        Animated.delay(randomDelay),
        Animated.parallel([
          Animated.timing(r.x, {
            toValue: config.destX,
            duration: CONFETTI_DURATION,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(r.y, {
            toValue: config.destY,
            duration: CONFETTI_DURATION,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(r.rotate, {
            toValue: 1,
            duration: CONFETTI_DURATION,
            useNativeDriver: true,
          }),
          // Opacity holds at 1 for 70% of the duration, fades to 0 in the
          // final 30%. Slightly shorter hold than the original spec since
          // the burst pieces travel further and risk overshooting the
          // viewport before fading; the longer fade window keeps the tail
          // gentle even at the edges.
          Animated.sequence([
            Animated.delay(CONFETTI_DURATION * 0.7),
            Animated.timing(r.opacity, {
              toValue: 0,
              duration: CONFETTI_DURATION * 0.3,
              useNativeDriver: true,
            }),
          ]),
        ]),
      ]);
    });

    // Tagline animation — runs in parallel with the confetti burst at
    // t=900. Opacity is a quick 200ms fade-in; scale uses the same spring
    // tuning as the hours.tsx pop pattern (friction 5, tension 200) so it
    // settles with the same brand "pop" feel as the hour value update on
    // the entry screen.
    const taglineAnimation = Animated.parallel([
      Animated.timing(taglineOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.spring(taglineScale, {
        toValue: 1,
        friction: 5,
        tension: 200,
        useNativeDriver: true,
      }),
    ]);

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
      // 3. Confetti burst + tagline reveal, both starting at the same
      // moment. The block resolves when ALL children finish — confetti
      // takes the full ~1200ms, tagline finishes earlier; the wait until
      // confetti is done is exactly the "tagline visible" hold we want
      // before fading.
      Animated.parallel([...confettiAnimations, taglineAnimation]),
      // 4. Hold so the eye settles on the completed check + tagline
      // before fade. Confetti is already gone by this point.
      Animated.delay(400),
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
  }, [
    visible,
    reduceMotion,
    scrimOpacity,
    overallOpacity,
    shortScale,
    longScale,
    taglineOpacity,
    taglineScale,
    onDismiss,
  ]);

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
            {/* Tagline. Positioned absolutely within the stage at
                PIVOT_Y + TAGLINE_OFFSET so the gap-below-check derives from
                the same pivot constant the strokes use. left:0/right:0 +
                alignItems:'center' centers the text horizontally within the
                stage. The Text can overflow the stage's vertical bound at
                large font sizes — RN's default overflow:'visible' allows
                that. The transform stack uses scale (uniform) so it pops
                from the center. */}
            <Animated.View
              style={[
                styles.tagline,
                {
                  opacity: taglineOpacity,
                  transform: [{ scale: taglineScale }],
                },
              ]}
            >
              <Text style={styles.taglineText}>{TAGLINE_TEXT}</Text>
            </Animated.View>
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
  tagline: {
    position: 'absolute',
    top: PIVOT_Y + TAGLINE_OFFSET,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  taglineText: {
    fontFamily: FONT_HANDWRITING,
    fontSize: TAGLINE_FONT_SIZE,
    color: colors.accent,
    letterSpacing: 2,
  },
});
