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
import { STUDIO_G_ACTIVITY_PINNING } from './firmSettings/seed/studioG';

export const FIRM_SETTING_KEYS = {
  ACTIVITY_SELECTION_MODE: 'activitySelectionMode',
  ACTIVITY_GROUPS_LAST_FULL_SYNC: 'activityGroupsLastFullSync',
  ACTIVITY_GROUPS_BG_PROGRESS: 'activityGroupsBackgroundProgress',
  ACTIVITY_PINNING: 'activityPinning',
  FIRM_SETTINGS_VERSION: 'firmSettingsVersion',
} as const;

export type ActivitySelectionMode = 'auto' | 'manual';

/**
 * Bumping this constant causes the next-launch seed pass to overwrite
 * `activityPinning` with the current STUDIO_G_ACTIVITY_PINNING payload.
 * Increment ANY time the seed file changes (group pin, project pin, or
 * structure). Users who haven't yet caught up to the new version pick
 * it up the next time `seedFirmSettingsIfStale` runs (typically the
 * next app launch).
 */
export const STUDIO_G_FIRM_SETTINGS_VERSION = 1;

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
  // Activity pinning payload. Future seeds (e.g. per-firm UI prefs) write
  // alongside this; the version key gates them all.
  await writeFirmSetting(
    FIRM_SETTING_KEYS.ACTIVITY_PINNING,
    JSON.stringify(STUDIO_G_ACTIVITY_PINNING),
  );
  await writeFirmSetting(
    FIRM_SETTING_KEYS.FIRM_SETTINGS_VERSION,
    String(STUDIO_G_FIRM_SETTINGS_VERSION),
  );
}
