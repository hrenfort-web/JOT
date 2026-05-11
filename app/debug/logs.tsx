// In-app log viewer. Reads from the ring buffer populated by
// utils/logBuffer.ts. Useful in TestFlight/Ad Hoc builds where there's no
// Metro to tail. Three actions:
//   - Copy all → dumps the buffer to the clipboard as plain text
//   - Clear   → empties the buffer
//   - Refresh → re-pulls latest (the screen doesn't auto-refresh; we
//               deliberately don't subscribe to console events to avoid
//               re-renders during noisy phases like initialSync)

import { useCallback, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { colors } from '../../theme';
import { clearLogs, getLogs, type LogLine } from '../../utils/logBuffer';
import { useToastStore } from '../../store/useToastStore';

export default function LogsScreen() {
  const [logs, setLogs] = useState<LogLine[]>(() => getLogs());
  const showToast = useToastStore((s) => s.show);

  const refresh = useCallback(() => {
    setLogs(getLogs());
  }, []);

  const onCopy = useCallback(async () => {
    try {
      const text = serialize(getLogs());
      await Clipboard.setStringAsync(text);
      showToast(`Copied ${logs.length} lines`, 'success');
    } catch (e) {
      showToast(
        `Copy failed: ${e instanceof Error ? e.message : 'unknown'}`,
        'error',
      );
    }
  }, [logs.length, showToast]);

  const onClear = useCallback(() => {
    clearLogs();
    setLogs([]);
    showToast('Logs cleared', 'info');
  }, [showToast]);

  // Newest first — matches what you want when diagnosing the latest failure.
  const sorted = [...logs].reverse();

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen
        options={{
          title: 'Logs',
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />

      <View style={styles.toolbar}>
        <ToolbarButton icon="copy-outline" label="Copy all" onPress={onCopy} />
        <ToolbarButton icon="refresh" label="Refresh" onPress={refresh} />
        <ToolbarButton
          icon="trash-outline"
          label="Clear"
          onPress={onClear}
          destructive
        />
      </View>

      <Text style={styles.countLine}>
        {logs.length === 0
          ? 'Buffer is empty.'
          : `${logs.length} line${logs.length === 1 ? '' : 's'} (newest first)`}
      </Text>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {sorted.map((line, i) => (
          <LogRow key={`${line.timestamp}-${i}`} line={line} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function ToolbarButton({
  icon,
  label,
  onPress,
  destructive,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tbBtn,
        pressed && styles.pressed,
        destructive && styles.tbBtnDestructive,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons
        name={icon}
        size={16}
        color={destructive ? colors.danger : colors.text}
      />
      <Text
        style={[
          styles.tbBtnText,
          destructive && styles.tbBtnTextDestructive,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const badgeStyle =
    line.level === 'error'
      ? styles.badgeError
      : line.level === 'warn'
        ? styles.badgeWarn
        : styles.badgeLog;
  return (
    <View style={styles.row}>
      <Text style={styles.timestamp}>{formatTime(line.timestamp)}</Text>
      <View style={[styles.badge, badgeStyle]}>
        <Text style={styles.badgeText}>{line.level.toUpperCase()}</Text>
      </View>
      <Text
        style={[
          styles.message,
          line.level === 'error' && styles.messageError,
        ]}
        selectable
      >
        {line.message}
      </Text>
    </View>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function serialize(lines: LogLine[]): string {
  return lines
    .map((l) => `${formatTime(l.timestamp)} [${l.level.toUpperCase()}] ${l.message}`)
    .join('\n');
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  toolbar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  tbBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tbBtnDestructive: {
    borderColor: colors.danger,
  },
  tbBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  tbBtnTextDestructive: {
    color: colors.danger,
  },
  pressed: {
    opacity: 0.75,
  },
  countLine: {
    fontSize: 11,
    color: colors.muted,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontFamily: 'monospace',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 32,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  timestamp: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: colors.muted,
    minWidth: 78,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    minWidth: 44,
    alignItems: 'center',
  },
  badgeLog: {
    backgroundColor: colors.subtle,
  },
  badgeWarn: {
    backgroundColor: '#FEF3C7',
  },
  badgeError: {
    backgroundColor: '#FEE2E2',
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 0.4,
  },
  message: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.text,
  },
  messageError: {
    color: colors.danger,
  },
});
