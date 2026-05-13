import * as SQLite from 'expo-sqlite';
import { MIGRATIONS, SCHEMA } from './schema';

const DB_NAME = 'jot.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(SCHEMA);
      for (const migration of MIGRATIONS) {
        try {
          await db.execAsync(migration);
        } catch {
          // duplicate column or already-applied migration; ignore
        }
      }
      return db;
    })();
  }
  return dbPromise;
}

export type SqlParam = string | number | null;

export async function run(sql: string, params: SqlParam[] = []) {
  const db = await getDb();
  return db.runAsync(sql, params);
}

export async function getAll<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
  const db = await getDb();
  return db.getAllAsync<T>(sql, params);
}

export async function getFirst<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
  const db = await getDb();
  const result = await db.getFirstAsync<T>(sql, params);
  return result ?? null;
}

/**
 * DIAGNOSTIC: emits [jot:tx] BEGIN/COMMIT/CATCH lines tagged with the
 * caller site + a random per-call id so the in-app log buffer can show
 * overlapping transactions if two `withTransactionAsync` calls race on
 * the shared SQLite connection. Pass a descriptive `siteLabel` (function
 * name) to identify the caller; defaults to "unknown".
 *
 * This is instrumentation only — no behavior change, no mutex. Once the
 * racing-transactions hypothesis is confirmed (or ruled out), this can
 * be reverted or kept as belt-and-suspenders observability.
 */
export async function transaction(
  fn: (db: SQLite.SQLiteDatabase) => Promise<void>,
  siteLabel?: string,
) {
  const db = await getDb();
  const label = siteLabel ?? 'unknown';
  const tag = Math.random().toString(36).slice(2, 8);
  console.log(`[jot:tx] BEGIN site=${label} tag=${tag}`);
  try {
    await db.withTransactionAsync(() => fn(db));
    console.log(`[jot:tx] COMMIT site=${label} tag=${tag}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[jot:tx] CATCH site=${label} tag=${tag} err=${msg}`);
    throw err;
  }
}

export async function upsertMany(
  table: string,
  columns: string[],
  rows: SqlParam[][],
  conflictKey: string,
  // Optional caller label for [jot:tx] trace lines. Defaults to the
  // table name so even un-labelled call sites produce useful output.
  siteLabel?: string,
): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = '(' + columns.map(() => '?').join(',') + ')';
  const updates = columns
    .filter((c) => c !== conflictKey)
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}
               ON CONFLICT(${conflictKey}) DO UPDATE SET ${updates}`;

  await transaction(async (db) => {
    const stmt = await db.prepareAsync(sql);
    try {
      for (const row of rows) {
        await stmt.executeAsync(row);
      }
    } finally {
      await stmt.finalizeAsync();
    }
  }, siteLabel ?? table);
}

const bool = (v: unknown): number => (v ? 1 : 0);
export const sqliteBool = bool;
