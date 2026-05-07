import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';

import { colors } from '../../theme';
import { useReminderStore } from '../../store/useReminderStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useEntryStore } from '../../store/useEntryStore';
import {
  cancelAllReminders,
  requestNotificationPermission,
  rescheduleAllReminders,
} from '../../services/notifications/reminders';
import {
  getLastSyncTime,
  runInitialSync,
} from '../../services/sync/initialSync';
import { useProjectStore } from '../../store/useProjectStore';
import { useToastStore } from '../../store/useToastStore';
import { getFirst } from '../../db/database';
import { PHASE_DEFAULTS } from '../../services/memos/suggestions';
import { phaseMeta } from '../../utils/phaseMeta';

const REMINDER_TIMES = [
  { label: '3 PM', hour: 15 },
  { label: '4 PM', hour: 16 },
  { label: '5 PM', hour: 17 },
  { label: '6 PM', hour: 18 },
  { label: '7 PM', hour: 19 },
];
const HOUR_OPTIONS_PER_DAY = [6, 7, 8, 9, 10];
const HOUR_OPTIONS_PER_WEEK = [30, 35, 40, 45, 50];

const FEEDBACK_EMAIL = 'feedback@jot.app';
const PRIVACY_URL = 'https://jot.app/privacy';

interface CacheStats {
  projects: number;
  activities: number;
  entries: number;
}

export default function SettingsScreen() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const demoMode = useAuthStore((s) => s.demoMode);

  const isLoaded = useReminderStore((s) => s.isLoaded);
  const prefs = useReminderStore((s) => s.prefs);
  const permissionGranted = useReminderStore((s) => s.permissionGranted);
  const permissionCanAskAgain = useReminderStore((s) => s.permissionCanAskAgain);
  const loadReminders = useReminderStore((s) => s.load);
  const refreshPermission = useReminderStore((s) => s.refreshPermission);
  const updatePrefs = useReminderStore((s) => s.updatePrefs);

  const refreshProjects = useProjectStore((s) => s.refresh);
  const pendingEntries = useEntryStore((s) => s.pendingEntries);
  const refreshEntries = useEntryStore((s) => s.refreshLocal);
  const showToast = useToastStore((s) => s.show);

  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [memoExpanded, setMemoExpanded] = useState(false);

  const loadStats = useCallback(async () => {
    const [last, projRow, actRow, entryRow] = await Promise.all([
      getLastSyncTime(),
      getFirst<{ n: number }>('SELECT COUNT(*) as n FROM LocalProject'),
      getFirst<{ n: number }>('SELECT COUNT(*) as n FROM LocalActivity'),
      getFirst<{ n: number }>('SELECT COUNT(*) as n FROM LocalTimeEntry'),
    ]);
    setLastSync(last);
    setCacheStats({
      projects: projRow?.n ?? 0,
      activities: actRow?.n ?? 0,
      entries: entryRow?.n ?? 0,
    });
  }, []);

  useEffect(() => {
    if (!isLoaded) loadReminders();
  }, [isLoaded, loadReminders]);

  useFocusEffect(
    useCallback(() => {
      loadStats();
      refreshEntries();
    }, [loadStats, refreshEntries]),
  );

  const handleEnableToggle = async (next: boolean) => {
    if (next && !permissionGranted) {
      if (permissionCanAskAgain) {
        const granted = await requestNotificationPermission();
        await refreshPermission();
        if (!granted) return;
      } else {
        Linking.openSettings();
        return;
      }
    }
    await updatePrefs({ enabled: next });
    if (!next) await cancelAllReminders();
  };

  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect from BQE Core?',
      'You will need to sign in again to log time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            logout();
          },
        },
      ],
    );
  };

  const handleSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await runInitialSync();
      await refreshProjects();
      await refreshEntries();
      await loadStats();
      showToast('Synced with BQE Core', 'success');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Sync failed';
      showToast(message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const userName =
    (user?.displayName as string | undefined) ??
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ??
    'Loading…';
  const userRole = ((user as Record<string, unknown> | null)?.role as string | undefined) ?? 'Staff';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Section title="Profile">
          <Row>
            <View style={styles.profileTop}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initialsOf(userName)}</Text>
              </View>
              <View style={styles.profileMeta}>
                <Text style={styles.profileName} numberOfLines={1}>
                  {userName}
                </Text>
                <Text style={styles.profileRole}>{capitalize(userRole)}</Text>
                <View style={styles.connectedRow}>
                  <View
                    style={[
                      styles.connectedDot,
                      demoMode && styles.connectedDotDemo,
                    ]}
                  />
                  <Text
                    style={[
                      styles.connectedText,
                      demoMode && styles.connectedTextDemo,
                    ]}
                  >
                    {demoMode ? 'Demo Mode' : 'Connected to BQE Core'}
                  </Text>
                </View>
              </View>
            </View>
          </Row>
          <Row onPress={handleDisconnect}>
            <Text style={styles.rowLabelDanger}>Disconnect</Text>
            <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          </Row>
        </Section>

        <Section title="Sync">
          <Row>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Last synced</Text>
              <Text style={styles.rowSubtle}>
                {lastSync ? formatRelative(lastSync) : 'Never'}
              </Text>
            </View>
          </Row>
          <Row onPress={handleSyncNow} disabled={syncing}>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Sync now</Text>
              <Text style={styles.rowSubtle}>Refresh projects, activities, and entries</Text>
            </View>
            {syncing ? (
              <Text style={styles.rowMeta}>Syncing…</Text>
            ) : (
              <Ionicons name="refresh" size={18} color={colors.muted} />
            )}
          </Row>
          {pendingEntries.length > 0 ? (
            <Row>
              <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>Pending entries</Text>
                <Text style={styles.rowSubtle}>
                  Will sync when online and BQE accepts them
                </Text>
              </View>
              <View style={styles.pendingPill}>
                <Text style={styles.pendingPillText}>{pendingEntries.length}</Text>
              </View>
            </Row>
          ) : null}
          <Row>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Cache size</Text>
              <Text style={styles.rowSubtle}>
                {cacheStats
                  ? `${cacheStats.projects} projects · ${cacheStats.activities} activities · ${cacheStats.entries} entries`
                  : 'Loading…'}
              </Text>
            </View>
          </Row>
        </Section>

        <Section title="Reminders">
          <Row>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Daily reminders</Text>
              <Text style={styles.rowSubtle}>
                Mon–Fri nudge plus Thu/Fri weekly check-ins
              </Text>
            </View>
            <Switch
              value={prefs.enabled && permissionGranted}
              onValueChange={handleEnableToggle}
              trackColor={{ true: colors.accent, false: colors.border }}
            />
          </Row>

          {prefs.enabled && !permissionGranted ? (
            <Pressable
              onPress={() =>
                permissionCanAskAgain
                  ? requestNotificationPermission().then(refreshPermission)
                  : Linking.openSettings()
              }
              style={({ pressed }) => [styles.warning, pressed && styles.rowPressed]}
            >
              <Ionicons name="alert-circle-outline" size={18} color="#92400E" />
              <Text style={styles.warningText}>
                {permissionCanAskAgain
                  ? 'Notifications are off. Tap to grant permission.'
                  : 'Notifications are blocked. Open Settings to enable.'}
              </Text>
            </Pressable>
          ) : null}

          <Row>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Daily reminder time</Text>
              <ChoiceRow
                options={REMINDER_TIMES.map((t) => ({ key: t.hour, label: t.label }))}
                value={prefs.hour}
                onChange={(v) => updatePrefs({ hour: v })}
              />
            </View>
          </Row>

          <Row>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Target hours per day</Text>
              <ChoiceRow
                options={HOUR_OPTIONS_PER_DAY.map((h) => ({ key: h, label: `${h}h` }))}
                value={prefs.targetPerDay}
                onChange={(v) => updatePrefs({ targetPerDay: v })}
              />
            </View>
          </Row>

          <Row>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Target hours per week</Text>
              <ChoiceRow
                options={HOUR_OPTIONS_PER_WEEK.map((h) => ({ key: h, label: `${h}h` }))}
                value={prefs.targetPerWeek}
                onChange={(v) => updatePrefs({ targetPerWeek: v })}
              />
            </View>
          </Row>

          <Row onPress={() => rescheduleAllReminders()}>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Refresh reminders now</Text>
              <Text style={styles.rowSubtle}>
                Recompute today's nudge based on current entries
              </Text>
            </View>
            <Ionicons name="refresh" size={18} color={colors.muted} />
          </Row>
        </Section>

        <Section title="Memo suggestions">
          <Row onPress={() => setMemoExpanded((e) => !e)}>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Manage memo suggestions</Text>
              <Text style={styles.rowSubtle}>
                Firm defaults shown below the memo field
              </Text>
            </View>
            <Ionicons
              name={memoExpanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.muted}
            />
          </Row>
          {memoExpanded ? (
            <View style={styles.memoList}>
              {Object.entries(PHASE_DEFAULTS).map(([code, memos]) => {
                const meta = phaseMeta(code, code);
                return (
                  <View key={code} style={styles.memoPhaseRow}>
                    <View style={styles.memoPhaseHeader}>
                      <View style={styles.memoPhaseBadge}>
                        <Text style={styles.memoPhaseBadgeText}>{meta.code}</Text>
                      </View>
                      <Text style={styles.memoPhaseName}>{meta.name}</Text>
                    </View>
                    {memos.map((m) => (
                      <Text key={m} style={styles.memoItem}>
                        · {m}
                      </Text>
                    ))}
                  </View>
                );
              })}
              <Text style={styles.memoNote}>
                Read-only. Admins can edit firm defaults in BQE Core (v2).
              </Text>
            </View>
          ) : null}
        </Section>

        <Section title="About">
          <Row>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>App version</Text>
            </View>
            <Text style={styles.rowMeta}>{appVersion()}</Text>
          </Row>
          <Row
            onPress={() =>
              Linking.openURL(`mailto:${FEEDBACK_EMAIL}?subject=Jot%20feedback`)
            }
          >
            <Text style={styles.rowLabel}>Send feedback</Text>
            <Ionicons name="mail-outline" size={18} color={colors.muted} />
          </Row>
          <Row onPress={() => Linking.openURL(PRIVACY_URL)}>
            <Text style={styles.rowLabel}>Privacy policy</Text>
            <Ionicons name="open-outline" size={18} color={colors.muted} />
          </Row>
        </Section>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Built by Jot</Text>
          <Ionicons name="heart" size={12} color={colors.accent} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

interface RowProps {
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
}

function Row({ children, onPress, disabled }: RowProps) {
  if (!onPress) {
    return <View style={styles.row}>{children}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
    >
      {children}
    </Pressable>
  );
}

interface ChoiceRowProps<T extends string | number> {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}

function ChoiceRow<T extends string | number>({ options, value, onChange }: ChoiceRowProps<T>) {
  return (
    <View style={styles.choiceRow}>
      {options.map((opt) => {
        const selected = opt.key === value;
        return (
          <Pressable
            key={String(opt.key)}
            onPress={() => onChange(opt.key)}
            style={({ pressed }) => [
              styles.choice,
              selected && styles.choiceSelected,
              pressed && styles.rowPressed,
            ]}
          >
            <Text
              style={[styles.choiceText, selected && styles.choiceTextSelected]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function appVersion(): string {
  const expoCfg = Constants.expoConfig as { version?: string } | null;
  return expoCfg?.version ?? '1.0.0';
}

function initialsOf(name: unknown): string {
  if (typeof name !== 'string') return '?';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const a = words[0][0] ?? '';
  const b = words[1][0] ?? '';
  return (a + b).toUpperCase() || '?';
}

function capitalize(s: unknown): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  const first = s[0];
  if (!first) return s;
  return first.toUpperCase() + s.slice(1);
}

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 24,
    paddingBottom: 32,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  sectionBody: {
    backgroundColor: colors.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.subtle,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowBody: {
    flex: 1,
    gap: 6,
  },
  rowLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  rowLabelDanger: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.danger,
  },
  rowSubtle: {
    fontSize: 12,
    color: colors.muted,
  },
  rowMeta: {
    fontSize: 13,
    color: colors.muted,
  },

  profileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 6,
    flex: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.accent,
  },
  profileMeta: {
    flex: 1,
    gap: 2,
  },
  profileName: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  profileRole: {
    fontSize: 12,
    color: colors.muted,
  },
  connectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  connectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  connectedDotDemo: {
    backgroundColor: colors.warning,
  },
  connectedTextDemo: {
    color: colors.warning,
  },
  connectedText: {
    fontSize: 12,
    color: colors.accent,
    fontWeight: '600',
  },

  pendingPill: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pendingPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#92400E',
  },

  warning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#FEF3C7',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: '#92400E',
  },

  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  choice: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: colors.subtle,
    borderWidth: 1,
    borderColor: colors.border,
  },
  choiceSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  choiceText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  choiceTextSelected: {
    color: '#FFFFFF',
  },

  memoList: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  memoPhaseRow: {
    gap: 4,
  },
  memoPhaseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  memoPhaseBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: colors.accentTint,
  },
  memoPhaseBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent,
  },
  memoPhaseName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  memoItem: {
    fontSize: 12,
    color: colors.muted,
    paddingLeft: 8,
  },
  memoNote: {
    fontSize: 11,
    color: colors.muted,
    fontStyle: 'italic',
    marginTop: 4,
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 4,
    paddingBottom: 12,
  },
  footerText: {
    fontSize: 12,
    color: colors.muted,
  },
});
