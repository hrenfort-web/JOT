// Thin wrapper around the LocalFirmSettings key-value table. Two read paths:
//
//   - readFirmSetting / writeFirmSetting — async, talk to SQLite directly.
//     Use these from sync workers and background jobs.
//   - useProjectStore.firmSettings — sync, in-memory mirror updated on
//     refresh(). Used by code paths that need to read settings inline (the
//     activity resolver in particular, which must be synchronous).
//
// The two views are kept in sync by `refresh()` re-reading the table.

import { getAll, run } from '../db/database';
import type { LocalFirmSettingRow } from '../db/schema';

export const FIRM_SETTING_KEYS = {
  ACTIVITY_SELECTION_MODE: 'activitySelectionMode',
  ACTIVITY_GROUPS_LAST_FULL_SYNC: 'activityGroupsLastFullSync',
  ACTIVITY_GROUPS_BG_PROGRESS: 'activityGroupsBackgroundProgress',
} as const;

export type ActivitySelectionMode = 'auto' | 'manual';

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
