import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../theme';

/**
 * One-tap escape from the entry flow back to the Home tab. Lives in the
 * top-right of the Stack header, mirroring the geometry of the native
 * back chevron on the left. Used by `app/entry/[projectId].tsx` (phase
 * picker) and `app/entry/hours.tsx` (hour entry).
 *
 * Navigation: prefers `router.dismissAll()` so the entry stack collapses
 * cleanly, falling back to `router.replace('/')` when the stack helper
 * isn't available. Matches the `goHome()` pattern already used inside
 * hours.tsx after a successful submit.
 *
 * Behaviour intentionally matches the existing back chevron: no
 * confirmation dialog. In-progress draft preservation is queued for v2
 * (spec §7.6); v1 trades a discarded draft for a fast escape.
 */
export function HeaderHomeButton() {
  const router = useRouter();

  const goHome = () => {
    if (router.canDismiss?.()) {
      router.dismissAll();
    } else {
      router.replace('/');
    }
  };

  return (
    <Pressable
      onPress={goHome}
      accessibilityRole="button"
      accessibilityLabel="Home"
      // Wider tap target than the visual circle — header buttons sit
      // close to the screen edge and benefit from extra slop.
      hitSlop={10}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Ionicons name="home-outline" size={20} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Circular Theme B surface with a hairline border — quietly visible,
  // not chrome that competes with the title. Same diameter (32px) as a
  // typical iOS nav-bar accessory and roughly matches the visual weight
  // of the native back chevron on the left.
  button: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  pressed: {
    backgroundColor: colors.accentTint,
  },
});
