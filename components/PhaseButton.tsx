import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

interface PhaseButtonProps {
  code: string;
  name: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}

export function PhaseButton({ code, name, icon, onPress }: PhaseButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, phase ${code}`}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={28} color={colors.accent} />
      </View>
      <Text style={styles.code}>{code}</Text>
      <Text style={styles.name} numberOfLines={2}>
        {name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pressed: {
    backgroundColor: colors.subtle,
    borderColor: colors.accent,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  code: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.5,
  },
  name: {
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
  },
});
