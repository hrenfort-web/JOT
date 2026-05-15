import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { PREF_KEYS, loadBooleanPref, saveBooleanPref } from '../utils/preferences';

const EXAMPLE_TEXT =
  'Mon\n  Smith Res - DD  6.5  struct coord\n  Oakwood - CD    2    document production\nTue\n  Smith Res - DD  4    client revisions';

export function TipCard() {
  const [collapsed, setCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const value = await loadBooleanPref(PREF_KEYS.scanTipCollapsed, false);
      if (!cancelled) setCollapsed(value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = () => {
    setCollapsed((current) => {
      const next = !(current ?? false);
      saveBooleanPref(PREF_KEYS.scanTipCollapsed, next);
      return next;
    });
  };

  const isCollapsed = collapsed ?? false;

  return (
    <View style={styles.card}>
      <Pressable onPress={toggle} style={styles.headerRow} accessibilityRole="button">
        <View style={styles.iconWrap}>
          <Ionicons name="bulb-outline" size={18} color={colors.accent} />
        </View>
        <Text style={styles.title}>Write it like this</Text>
        <Ionicons
          name={isCollapsed ? 'chevron-down' : 'chevron-up'}
          size={18}
          color={colors.muted}
        />
      </Pressable>

      {!isCollapsed ? (
        <View style={styles.body}>
          <View style={styles.exampleBox}>
            <Text style={styles.example}>{EXAMPLE_TEXT}</Text>
          </View>
          <Text style={styles.subtitle}>
            Project + phase + hours + what you worked on. We'll match it for you.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  body: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 10,
  },
  exampleBox: {
    backgroundColor: colors.subtle,
    borderRadius: 10,
    padding: 12,
  },
  example: {
    fontFamily: monoFont,
    fontSize: 12,
    color: colors.text,
    lineHeight: 18,
  },
  subtitle: {
    fontSize: 12,
    color: colors.muted,
  },
});
