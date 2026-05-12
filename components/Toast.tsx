import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { useToastStore } from '../store/useToastStore';

// Theme B toast palette: tinted surfaces, NOT solid coloured fills. The
// prior version filled the toast with accent (green→orange) and white
// text — which read as a heavy chrome notification banner. Theme B tints
// keep the toast feeling like a quiet status acknowledgement: the success
// toast picks up the accent-muted background + accent text, the error
// toast picks up the danger tint, and the info toast uses a neutral
// cream surface with primary text.
type TonePalette = {
  background: string;
  border: string;
  text: string;
  icon: string;
};

const TONES: Record<'success' | 'error' | 'info', TonePalette> = {
  success: {
    background: colors.accentTint,
    border: colors.accent,
    text: colors.accent,
    icon: colors.accent,
  },
  error: {
    background: colors.dangerTint,
    border: colors.danger,
    text: colors.danger,
    icon: colors.danger,
  },
  info: {
    background: colors.surface,
    border: colors.border,
    text: colors.text,
    icon: colors.textSecondary,
  },
};

export function Toast() {
  const message = useToastStore((s) => s.message);
  const kind = useToastStore((s) => s.kind);
  const hide = useToastStore((s) => s.hide);

  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (message) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          friction: 8,
          tension: 80,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 80,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [message, opacity, translateY]);

  if (!message) return null;

  const icon =
    kind === 'success' ? 'checkmark-circle' : kind === 'error' ? 'alert-circle' : 'information-circle';
  const tone = TONES[kind ?? 'info'] ?? TONES.info;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { opacity, transform: [{ translateY }] }]}
    >
      <Pressable
        onPress={hide}
        style={[
          styles.toast,
          { backgroundColor: tone.background, borderColor: tone.border },
        ]}
        accessibilityRole="alert"
      >
        <Ionicons name={icon} size={20} color={tone.icon} />
        <Text style={[styles.text, { color: tone.text }]} numberOfLines={2}>
          {message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 32,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: '60%',
    maxWidth: '100%',
    // Softer shadow to match Theme B's calmer surfaces. The toast is a
    // status note, not an alert dialog — it shouldn't punch a hole in
    // the cream page.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 4,
  },
  text: {
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
  },
});
