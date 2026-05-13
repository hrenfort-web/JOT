// Studio G admin stats — internal one-off measurement tool.
//
// Pulls firm-wide /timeentry data for a configurable window, computes
// baseline metrics about timekeeping behavior (submission lag, Friday
// bunching, per-employee patterns), and renders unicode-bar charts plus
// a JSON export.
//
// This is not a customer feature. Code quality is intentionally pragmatic:
// no chart library, no date-picker library, no virtualized tables. It
// exists to capture pre-launch baselines we can compare against post-
// launch data once Jot is in regular use.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../../theme';
import { fetchAllPages } from '../../services/bqe/client';
import { useProjectStore } from '../../store/useProjectStore';
import { loadEmployees } from '../../services/bqe/employee';
import type { LocalEmployee } from '../../db/schema';
import { toIsoDay } from '../../utils/dateHelpers';

interface BqeTimeEntryRaw {
  id: string;
  resourceId?: string;
  date?: string;
  actualHours?: number;
  hours?: number;
  // BQE has shipped this under a few names across versions; we try them in
  // order at parse time.
  dateCreated?: string;
  createdDate?: string;
  createdAt?: string;
}

interface NormalizedEntry {
  id: string;
  resourceId: string;
  workDate: string; // ISO yyyy-mm-dd
  hours: number;
  createdAt: string | null; // ISO timestamp, null when BQE didn't return one
}

const FIELDS =
  'id,resourceId,date,actualHours,hours,dateCreated,createdDate,createdAt';

const PRESETS: { label: string; days: number }[] = [
  { label: '28 days', days: 28 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
];

export default function StatsScreen() {
  const [days, setDays] = useState(28);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<NormalizedEntry[]>([]);
  const [employees, setEmployees] = useState<LocalEmployee[]>([]);

  const flatProjects = useProjectStore((s) => s.flatProjects);
  const projectsLoaded = flatProjects.length > 0;

  const range = useMemo(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    return { startIso: toIsoDay(start), endIso: toIsoDay(end) };
  }, [days]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [emps, raw] = await Promise.all([
        loadEmployees(),
        fetchAllPages<BqeTimeEntryRaw>('/timeentry', {
          where: `date>='${range.startIso}' AND date<='${range.endIso}'`,
          fields: FIELDS,
        }),
      ]);
      setEmployees(emps);
      setEntries(raw.map(normalize).filter((e): e is NormalizedEntry => e !== null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch entries');
    } finally {
      setLoading(false);
    }
  }, [range.startIso, range.endIso]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const employeesById = useMemo(() => {
    const m = new Map<string, LocalEmployee>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  const stats = useMemo(() => computeStats(entries), [entries]);

  const onExport = async () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      range,
      windowDays: days,
      headline: stats.headline,
      lagDistribution: stats.lagBuckets,
      lagMedianDays: stats.medianLag,
      dayOfWeekDistribution: stats.dayOfWeekPct,
      perEmployee: stats.perEmployee.map((p) => ({
        ...p,
        displayName: employeesById.get(p.resourceId)?.displayName ?? null,
      })),
      sampleSize: entries.length,
    };
    try {
      await Share.share({
        message: JSON.stringify(payload, null, 2),
        title: 'Studio G stats export',
      });
    } catch {
      // user cancelled or share failed — nothing to do
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen
        options={{
          title: 'Studio G stats',
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.rangeRow}>
          {PRESETS.map((p) => (
            <Pressable
              key={p.days}
              onPress={() => setDays(p.days)}
              style={({ pressed }) => [
                styles.rangeBtn,
                days === p.days && styles.rangeBtnActive,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Set range to ${p.label}`}
            >
              <Text
                style={[
                  styles.rangeBtnText,
                  days === p.days && styles.rangeBtnTextActive,
                ]}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={fetchData}
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Refresh"
          >
            <Ionicons name="refresh" size={16} color={colors.text} />
          </Pressable>
        </View>

        <Text style={styles.windowLabel}>
          {range.startIso} → {range.endIso} · {!projectsLoaded ? 'projects not loaded' : ''}
        </Text>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.muted}>Pulling firm-wide entries…</Text>
          </View>
        ) : error ? (
          <View style={styles.errorWrap}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={fetchData} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.cardRow}>
              <BigCard
                label="Median lag"
                value={
                  stats.medianLag !== null ? `${stats.medianLag.toFixed(1)} d` : '—'
                }
                hint="from work day to log time"
              />
              <BigCard
                label="Friday-logged"
                value={
                  stats.headline.fridayPct !== null
                    ? `${Math.round(stats.headline.fridayPct * 100)}%`
                    : '—'
                }
                hint="of weekly hours"
              />
            </View>
            <View style={styles.cardRow}>
              <BigCard
                label="Total hours"
                value={`${stats.headline.totalHours.toFixed(0)}`}
                hint={`${entries.length} entries`}
              />
              <BigCard
                label="Active staff"
                value={`${stats.headline.activeEmployees}`}
                hint={`${stats.headline.entriesPerEmployeePerWeek.toFixed(1)} entries/wk avg`}
              />
            </View>

            <SectionHeader>Submission lag</SectionHeader>
            <BarChart
              rows={stats.lagBuckets.map((b) => ({
                label: b.label,
                pct: b.pct,
                count: b.count,
              }))}
            />

            <SectionHeader>When are entries logged? (day of week)</SectionHeader>
            <BarChart
              rows={stats.dayOfWeekPct.map((d) => ({
                label: d.day,
                pct: d.pct,
                count: d.count,
              }))}
            />

            <SectionHeader>
              Per employee (sorted by Friday-bunching, worst first)
            </SectionHeader>
            <View style={styles.tableHead}>
              <Text style={[styles.cell, styles.cellName]}>Name</Text>
              <Text style={[styles.cell, styles.cellNum]}>Hrs</Text>
              <Text style={[styles.cell, styles.cellNum]}>Lag</Text>
              <Text style={[styles.cell, styles.cellNum]}>Fri%</Text>
            </View>
            {stats.perEmployee.length === 0 ? (
              <Text style={styles.muted}>No entries in window.</Text>
            ) : (
              stats.perEmployee.map((p) => (
                <View key={p.resourceId} style={styles.tableRow}>
                  <Text style={[styles.cell, styles.cellName]} numberOfLines={1}>
                    {employeesById.get(p.resourceId)?.displayName ?? p.resourceId.slice(0, 8)}
                  </Text>
                  <Text style={[styles.cell, styles.cellNum]}>
                    {p.totalHours.toFixed(0)}
                  </Text>
                  <Text style={[styles.cell, styles.cellNum]}>
                    {p.avgLagDays !== null ? p.avgLagDays.toFixed(1) : '—'}
                  </Text>
                  <Text
                    style={[
                      styles.cell,
                      styles.cellNum,
                      p.fridayPct !== null && p.fridayPct >= 0.5 && styles.cellWarn,
                    ]}
                  >
                    {p.fridayPct !== null ? `${Math.round(p.fridayPct * 100)}%` : '—'}
                  </Text>
                </View>
              ))
            )}

            <Pressable
              onPress={onExport}
              style={({ pressed }) => [
                styles.exportBtn,
                pressed && styles.exportBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Export raw analysis as JSON"
            >
              <Ionicons name="share-outline" size={16} color={colors.surface} />
              <Text style={styles.exportBtnText}>Export as JSON</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// -------------------------------------------------------------------------
// Subcomponents
// -------------------------------------------------------------------------

function BigCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <View style={styles.bigCard}>
      <Text style={styles.bigCardLabel}>{label}</Text>
      <Text style={styles.bigCardValue}>{value}</Text>
      {hint ? <Text style={styles.bigCardHint}>{hint}</Text> : null}
    </View>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionHeader}>{children}</Text>;
}

function BarChart({ rows }: { rows: { label: string; pct: number; count: number }[] }) {
  const maxBlocks = 20;
  return (
    <View style={styles.barChart}>
      {rows.map((r) => {
        const filled = Math.round(Math.max(0, Math.min(1, r.pct)) * maxBlocks);
        const bar = '█'.repeat(filled) + '░'.repeat(maxBlocks - filled);
        return (
          <View key={r.label} style={styles.barRow}>
            <Text style={styles.barLabel} numberOfLines={1}>
              {r.label}
            </Text>
            <Text style={styles.barBlocks}>{bar}</Text>
            <Text style={styles.barPct}>
              {Math.round(r.pct * 100)}% ({r.count})
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// -------------------------------------------------------------------------
// Stats math
// -------------------------------------------------------------------------

function normalize(raw: BqeTimeEntryRaw): NormalizedEntry | null {
  if (!raw.id || !raw.resourceId || !raw.date) return null;
  const hours = Number(raw.actualHours ?? raw.hours ?? 0);
  const createdAt =
    raw.dateCreated ?? raw.createdDate ?? raw.createdAt ?? null;
  return {
    id: raw.id,
    resourceId: raw.resourceId,
    workDate: raw.date.slice(0, 10),
    hours: Number.isFinite(hours) ? hours : 0,
    createdAt,
  };
}

interface LagBucket {
  label: string;
  count: number;
  pct: number;
}

interface DayOfWeekRow {
  day: string;
  count: number;
  pct: number;
}

interface PerEmployeeRow {
  resourceId: string;
  totalHours: number;
  totalEntries: number;
  avgLagDays: number | null;
  fridayPct: number | null;
}

interface ComputedStats {
  headline: {
    fridayPct: number | null;
    totalHours: number;
    activeEmployees: number;
    avgHoursPerEntry: number;
    entriesPerEmployeePerWeek: number;
  };
  medianLag: number | null;
  lagBuckets: LagBucket[];
  dayOfWeekPct: DayOfWeekRow[];
  perEmployee: PerEmployeeRow[];
}

function computeStats(entries: NormalizedEntry[]): ComputedStats {
  const total = entries.length;

  // --- lag distribution -------------------------------------------------
  const lagDays: number[] = [];
  for (const e of entries) {
    const lag = lagInDays(e);
    if (lag != null) lagDays.push(lag);
  }
  const buckets = [
    { label: 'Same day', test: (d: number) => d === 0 },
    { label: '1 day', test: (d: number) => d === 1 },
    { label: '2–3 days', test: (d: number) => d >= 2 && d <= 3 },
    { label: '4–7 days', test: (d: number) => d >= 4 && d <= 7 },
    { label: '8+ days', test: (d: number) => d >= 8 },
  ];
  const lagBuckets: LagBucket[] = buckets.map((b) => {
    const count = lagDays.filter((d) => b.test(d)).length;
    return {
      label: b.label,
      count,
      pct: lagDays.length > 0 ? count / lagDays.length : 0,
    };
  });
  const medianLag = lagDays.length > 0 ? median(lagDays) : null;

  // --- day-of-week of createdAt ----------------------------------------
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayCounts = new Array(7).fill(0) as number[];
  let dayCountTotal = 0;
  let fridayHours = 0;
  let totalHours = 0;
  for (const e of entries) {
    totalHours += e.hours;
    if (e.createdAt) {
      const d = new Date(e.createdAt);
      if (!Number.isNaN(d.getTime())) {
        const dow = d.getDay();
        dayCounts[dow] += 1;
        dayCountTotal += 1;
        if (dow === 5) fridayHours += e.hours;
      }
    }
  }
  const dayOfWeekPct: DayOfWeekRow[] = dayNames.map((label, i) => ({
    day: label,
    count: dayCounts[i],
    pct: dayCountTotal > 0 ? dayCounts[i] / dayCountTotal : 0,
  }));
  const fridayPct = totalHours > 0 ? fridayHours / totalHours : null;

  // --- per-employee -----------------------------------------------------
  const byEmployee = new Map<string, NormalizedEntry[]>();
  for (const e of entries) {
    const list = byEmployee.get(e.resourceId) ?? [];
    list.push(e);
    byEmployee.set(e.resourceId, list);
  }
  const perEmployee: PerEmployeeRow[] = [];
  for (const [resourceId, list] of byEmployee.entries()) {
    let hrs = 0;
    let lagSum = 0;
    let lagCount = 0;
    let friCount = 0;
    let createdCount = 0;
    for (const e of list) {
      hrs += e.hours;
      const lag = lagInDays(e);
      if (lag != null) {
        lagSum += lag;
        lagCount += 1;
      }
      if (e.createdAt) {
        const d = new Date(e.createdAt);
        if (!Number.isNaN(d.getTime())) {
          createdCount += 1;
          if (d.getDay() === 5) friCount += 1;
        }
      }
    }
    perEmployee.push({
      resourceId,
      totalHours: hrs,
      totalEntries: list.length,
      avgLagDays: lagCount > 0 ? lagSum / lagCount : null,
      fridayPct: createdCount > 0 ? friCount / createdCount : null,
    });
  }
  perEmployee.sort((a, b) => (b.fridayPct ?? -1) - (a.fridayPct ?? -1));

  // --- entry volume -----------------------------------------------------
  const activeEmployees = byEmployee.size;
  const avgHoursPerEntry = total > 0 ? totalHours / total : 0;
  // Window in weeks is approximated from the entries themselves: span
  // from earliest workDate to latest. Falls back to 4 weeks for very small
  // samples.
  const dates = entries.map((e) => e.workDate).sort();
  let weeksSpan = 4;
  if (dates.length >= 2) {
    const first = new Date(dates[0]);
    const last = new Date(dates[dates.length - 1]);
    const days = Math.max(1, (last.getTime() - first.getTime()) / 86400000);
    weeksSpan = Math.max(1, days / 7);
  }
  const entriesPerEmployeePerWeek =
    activeEmployees > 0 ? total / (activeEmployees * weeksSpan) : 0;

  return {
    headline: {
      fridayPct,
      totalHours,
      activeEmployees,
      avgHoursPerEntry,
      entriesPerEmployeePerWeek,
    },
    medianLag,
    lagBuckets,
    dayOfWeekPct,
    perEmployee,
  };
}

function lagInDays(e: NormalizedEntry): number | null {
  if (!e.createdAt) return null;
  const created = new Date(e.createdAt);
  const work = new Date(e.workDate);
  if (Number.isNaN(created.getTime()) || Number.isNaN(work.getTime())) return null;
  // Created — work, in calendar days (rounded down). Negative values
  // (logged before the work date — pre-fill) clamp to 0 so they don't
  // distort the lag distribution.
  const diffMs = stripTime(created).getTime() - stripTime(work).getTime();
  const days = Math.floor(diffMs / 86400000);
  return Math.max(0, days);
}

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// -------------------------------------------------------------------------
// Styles
// -------------------------------------------------------------------------

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 14,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 12,
  },
  // Range chooser — same cream/hairline + accent-on-select treatment
  // used by the choice pill in settings and the base hour button on the
  // entry screen.
  rangeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rangeBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  rangeBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
  },
  rangeBtnTextActive: {
    color: colors.surface,
  },
  refreshBtn: {
    marginLeft: 'auto',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  windowLabel: {
    fontSize: 11,
    color: colors.textTertiary,
    fontFamily: 'monospace',
  },
  pressed: {
    opacity: 0.75,
  },
  loadingWrap: {
    paddingVertical: 48,
    alignItems: 'center',
    gap: 8,
  },
  errorWrap: {
    paddingVertical: 32,
    alignItems: 'center',
    gap: 8,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  retryText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  muted: {
    color: colors.textTertiary,
    fontSize: 12,
  },

  cardRow: {
    flexDirection: 'row',
    gap: 10,
  },
  bigCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 12,
    gap: 4,
  },
  // Stat-card label: sentence case, weight 500, textSecondary — matches
  // the Theme B section-header convention used throughout the app.
  bigCardLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
    letterSpacing: 0.2,
  },
  bigCardValue: {
    fontSize: 24,
    fontWeight: '500',
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  bigCardHint: {
    fontSize: 11,
    color: colors.textTertiary,
  },

  sectionHeader: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    letterSpacing: 0.2,
    marginTop: 8,
  },
  barChart: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 12,
    gap: 4,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  barLabel: {
    width: 78,
    fontSize: 12,
    color: colors.text,
  },
  barBlocks: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    color: colors.accent,
  },
  barPct: {
    width: 80,
    textAlign: 'right',
    fontSize: 11,
    color: colors.textTertiary,
    fontVariant: ['tabular-nums'],
  },

  tableHead: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cell: {
    fontSize: 12,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  cellName: {
    flex: 1,
    fontWeight: '500',
  },
  cellNum: {
    width: 56,
    textAlign: 'right',
  },
  cellWarn: {
    color: colors.danger,
    fontWeight: '500',
  },

  // Export — primary pill, matches the geometry of login + hours
  // submit. Bumped to 56-tall radius-28 for consistency even though
  // this is an internal admin tool.
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    borderRadius: 28,
    height: 56,
    marginTop: 16,
  },
  exportBtnPressed: {
    backgroundColor: colors.accentPressed,
  },
  exportBtnText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '500',
  },
});
