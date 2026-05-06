import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { useToastStore } from '../store/useToastStore';

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
  const background =
    kind === 'success' ? colors.accent : kind === 'error' ? colors.danger : colors.text;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { opacity, transform: [{ translateY }] }]}
    >
      <Pressable
        onPress={hide}
        style={[styles.toast, { backgroundColor: background }]}
        accessibilityRole="alert"
      >
        <Ionicons name={icon} size={20} color="#FFFFFF" />
        <Text style={styles.text} numberOfLines={2}>
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
    minWidth: '60%',
    maxWidth: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  text: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
});
