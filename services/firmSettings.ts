// Thin wrapper around the LocalFirmSettings key-value table. Two read paths:
//
//   - readFirmSetting / writeFirmSetting — async, talk to SQLite directly.
//     Use these from sync workers and background jobs.
//   - useProjectStore.firmSettings — sync, in-memory mirror updated on
//     refresh(). Used by code paths that need to read settings inline (the
//     activity resolver in particular, which must be synchronous).
//
// The two views are kept in sync by `refresh()` re-reading the table.
//
// Versioned seed: a curated firm-default payload (e.g. Studio G's activity
// pinning) is written to LocalFirmSettings on app launch if the stored
// schema version is older than STUDIO_G_FIRM_SETTINGS_VERSION. Bumping the
// constant in the same commit as a seed change propagates pin updates to
// every user on next launch without needing a migration.

import { getAll, run } from '../db/database';
import type { LocalFirmSettingRow } from '../db/schema';
import {
  STUDIO_G_ACTIVITY_PINNING,
  STUDIO_G_MEMO_TEMPLATES_SEED,
  STUDIO_G_SCAN_LOOKUP_OPTIONS,
} from './firmSettings/seed/studioG';

export const FIRM_SETTING_KEYS = {
  ACTIVITY_SELECTION_MODE: 'activitySelectionMode',
  ACTIVITY_GROUPS_LAST_FULL_SYNC: 'activityGroupsLastFullSync',
  ACTIVITY_GROUPS_BG_PROGRESS: 'activityGroupsBackgroundProgress',
  ACTIVITY_PINNING: 'activityPinning',
  MEMO_TEMPLATES: 'memoTemplates',
  SCAN_LOOKUP_OPTIONS: 'scanLookupOptions',
  FIRM_SETTINGS_VERSION: 'firmSettingsVersion',
} as const;

export type ActivitySelectionMode = 'auto' | 'manual';

/**
 * Bumping this constant causes the next-launch seed pass to overwrite the
 * seeded payloads (`activityPinning` + `memoTemplates`) with the current
 * STUDIO_G_* payloads. Increment ANY time a seed file changes (group pin,
 * project pin, memo template, or structure). Users who haven't yet caught
 * up to the new version pick it up the next time `seedFirmSettingsIfStale`
 * runs (typically the next app launch).
 *
 * v2 adds memoTemplates (phase-name-keyed memo suggestion chips).
 * v3 expands memoTemplates with alias phrases (STUDIO_G_MEMO_TEMPLATES_SEED).
 * v4 adds scanLookupOptions (firm-configurable cap on the scan project pool;
 *    Studio G uses 250, effectively no cap at current firm size).
 */
export const STUDIO_G_FIRM_SETTINGS_VERSION = 4;

export async function loadFirmSettings(): Promise<Record<string, string>> {
  const rows = await getAll<LocalFirmSettingRow>(
    'SELECT key, value, lastUpdated FROM LocalFirmSettings',
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.value !== null && r.value !== undefined) {
      out[r.key] = r.value;
    }
  }
  return out;
}

export async function readFirmSetting(key: string): Promise<string | null> {
  const rows = await getAll<LocalFirmSettingRow>(
    'SELECT key, value, lastUpdated FROM LocalFirmSettings WHERE key = ?',
    [key],
  );
  if (rows.length === 0) return null;
  return rows[0].value;
}

/**
 * Upsert a single setting. Pass null to clear (the key stays in the table
 * with a null value, so downstream `WHERE value IS NULL` queries can find it
 * — readFirmSetting returns null in that case).
 */
export async function writeFirmSetting(
  key: string,
  value: string | null,
): Promise<void> {
  await run(
    `INSERT INTO LocalFirmSettings (key, value, lastUpdated)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, lastUpdated = excluded.lastUpdated`,
    [key, value, new Date().toISOString()],
  );
}

/**
 * Idempotent versioned seed.
 *
 * Reads `firmSettingsVersion` from LocalFirmSettings, compares to
 * STUDIO_G_FIRM_SETTINGS_VERSION, and writes the current seed payload
 * (currently `activityPinning`) when stale. Leaves other keys alone —
 * specifically does NOT touch `activitySelectionMode`, which is seeded
 * by the SCHEMA-level INSERT OR IGNORE so user overrides survive.
 *
 * Safe to call multiple times per launch: when the version matches,
 * this is a single SELECT and returns immediately.
 *
 * Called from useProjectStore.refresh() before the in-memory mirror is
 * hydrated so the resolver sees the freshest seed on every refresh.
 */
export async function seedFirmSettingsIfStale(): Promise<void> {
  const storedVersionRaw = await readFirmSetting(FIRM_SETTING_KEYS.FIRM_SETTINGS_VERSION);
  const storedVersion = storedVersionRaw != null ? Number(storedVersionRaw) : 0;
  if (Number.isFinite(storedVersion) && storedVersion >= STUDIO_G_FIRM_SETTINGS_VERSION) {
    return; // up to date — fast path
  }
  if (__DEV__) {
    console.log(
      `[jot:firmSettings] seed: stored v${storedVersion} < current v${STUDIO_G_FIRM_SETTINGS_VERSION} — writing payload`,
    );
  }
  // Seed payloads. Future seeds (e.g. per-firm UI prefs) write alongside
  // these; the version key gates them all.
  await writeFirmSetting(
    FIRM_SETTING_KEYS.ACTIVITY_PINNING,
    JSON.stringify(STUDIO_G_ACTIVITY_PINNING),
  );
  await writeFirmSetting(
    FIRM_SETTING_KEYS.MEMO_TEMPLATES,
    JSON.stringify(STUDIO_G_MEMO_TEMPLATES_SEED),
  );
  await writeFirmSetting(
    FIRM_SETTING_KEYS.SCAN_LOOKUP_OPTIONS,
    JSON.stringify(STUDIO_G_SCAN_LOOKUP_OPTIONS),
  );
  await writeFirmSetting(
    FIRM_SETTING_KEYS.FIRM_SETTINGS_VERSION,
    String(STUDIO_G_FIRM_SETTINGS_VERSION),
  );
}

// Letters-only, lowercase normalization — single source of truth for both
// the seed-key index built below and the incoming phase-name lookup. Keeps
// "20 Schematic Design" matching the LocalProject phase name regardless of
// leading numbers or punctuation drift.
function normalizePhaseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

// Memoized normalized index over the seeded memoTemplates payload — a
// length-sorted array (longest normalized key first) so substring matching
// resolves longest-key-wins. Rebuilt only when the raw payload string
// changes (i.e. after a re-seed), so the per-key normalization + sort run
// once per payload, not once per call.
let memoTemplateIndex: Array<{ key: string; chips: string[] }> | null = null;
let memoTemplateIndexSource: string | null = null;

/**
 * Return the firm's memo-suggestion chips for a phase, matched by normalized
 * substring containment (longest matching key wins), or null if no template
 * matches.
 *
 * Matching is firm-agnostic: the incoming phase name is normalized, then the
 * first (longest) seed key the normalized name CONTAINS supplies the chips.
 * All firm-specific keys/aliases live in the seeded payload (studioG.ts).
 *
 * Reads the seeded `memoTemplates` payload via the same firm-settings store
 * the other seeded payloads are read from (readFirmSetting), so a future
 * per-firm override of memoTemplates is honored automatically. Async to
 * match that read path; the single call site already awaits it.
 */
export async function getMemoTemplatesForPhase(
  phaseName: string,
): Promise<string[] | null> {
  const raw = await readFirmSetting(FIRM_SETTING_KEYS.MEMO_TEMPLATES);
  if (!raw) return null;
  if (raw !== memoTemplateIndexSource) {
    // Rebuild the length-sorted index once per distinct payload.
    const next: Array<{ key: string; chips: string[] }> = [];
    try {
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      for (const [name, chips] of Object.entries(parsed)) {
        const key = normalizePhaseName(name);
        // Skip empty normalized keys — an empty key is a substring of every
        // string and would match everything.
        if (key.length === 0) continue;
        next.push({ key, chips });
      }
    } catch {
      return null;
    }
    // Longest key first so the most specific match wins. Sort only swaps on
    // strict length difference, so equal-length keys keep insertion order
    // (Object.entries = declaration order) — a stable tie-break.
    next.sort((a, b) => b.key.length - a.key.length);
    memoTemplateIndex = next;
    memoTemplateIndexSource = raw;
  }
  if (!memoTemplateIndex) return null;
  const target = normalizePhaseName(phaseName);
  for (const entry of memoTemplateIndex) {
    if (target.includes(entry.key)) return entry.chips;
  }
  return null;
}
