import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

interface PhaseButtonProps {
  code: string;
  name: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}

// Theme B phase tile: cream surface, hairline border, near-black text.
// The icon is structural here (it names the kind of phase) NOT the accent
// moment — it renders in primary text so the code+name stay the focus.
// On press, the whole tile briefly fills with accentMuted and the icon +
// code shift to accent, signalling the choice while the screen transitions.
export function PhaseButton({ code, name, icon, onPress }: PhaseButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, phase ${code}`}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {({ pressed }) => (
        <>
          <Ionicons
            name={icon}
            size={24}
            color={pressed ? colors.accent : colors.text}
          />
          <View style={styles.labels}>
            <Text style={[styles.code, pressed && styles.codePressed]}>
              {code}
            </Text>
            <Text style={styles.name} numberOfLines={2}>
              {name}
            </Text>
          </View>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    minHeight: 96,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 20,
    paddingHorizontal: 16,
    gap: 12,
    // Icon top-left, code+name below — a calm reading order rather than
    // the centered "destination tile" look the prior treatment had.
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  pressed: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
  },
  labels: {
    gap: 4,
  },
  code: {
    fontSize: 20,
    fontWeight: '500',
    color: colors.text,
  },
  codePressed: {
    color: colors.accent,
  },
  name: {
    fontSize: 13,
    fontWeight: '400',
    color: colors.textSecondary,
  },
});
