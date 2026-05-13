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
 * Single-slot promise queue that serializes every `transaction()` call
 * onto the shared SQLite connection. expo-sqlite's
 * `withTransactionAsync` has no JS-level mutex — two callers entering
 * at the same JS turn race through its `BEGIN ... COMMIT/ROLLBACK`
 * sequence and throw "cannot start a transaction within a transaction"
 * / "cannot rollback - no transaction is active".
 *
 * Confirmed via [jot:tx] trace: two parallel `loadWeek` calls from the
 * home screen fire `persistFetchedEntries` simultaneously, collide in
 * the wrapper. The fix is structural — gate every transaction through
 * this queue so only one is in-flight at any moment, regardless of
 * which site triggered it.
 *
 * The chain is re-pointed at `myTurn.catch(() => {})` so a failed
 * transaction doesn't poison the queue for subsequent callers; the
 * original rejection still propagates to the caller that started it.
 *
 * KNOWN LIMITATION: a reentrant `transaction()` call from inside an
 * `fn` callback would deadlock — `myTurn` awaits `txGate`, but `txGate`
 * is still resolving the outer transaction's promise. None of the six
 * current call sites do this (all are top-level inserts that don't
 * call back into `transaction()` themselves), and `upsertMany` is the
 * only public path that opens a transaction. If a future call site
 * needs reentrancy, switch to a recursive mutex or a `withConnection`
 * pattern that passes the active txn handle through.
 */
let txGate: Promise<unknown> = Promise.resolve();

/**
 * Wraps `db.withTransactionAsync(fn)` with:
 *   1. The single-slot mutex above (serializes against every other
 *      transaction on the shared connection).
 *   2. `[jot:tx] BEGIN/COMMIT/CATCH` trace lines tagged with the caller
 *      `siteLabel` + a random per-call id. The trace lines route through
 *      `utils/logBuffer` so the in-app log viewer captures them.
 *
 * `siteLabel` is optional but always worth passing — defaults to
 * "unknown" otherwise. `upsertMany` falls back to the table name when
 * its own caller doesn't supply one.
 */
export async function transaction(
  fn: (db: SQLite.SQLiteDatabase) => Promise<void>,
  siteLabel?: string,
) {
  const db = await getDb();
  const label = siteLabel ?? 'unknown';
  const tag = Math.random().toString(36).slice(2, 8);

  const myTurn = txGate.then(async () => {
    console.log(`[jot:tx] BEGIN site=${label} tag=${tag}`);
    try {
      await db.withTransactionAsync(() => fn(db));
      console.log(`[jot:tx] COMMIT site=${label} tag=${tag}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[jot:tx] CATCH site=${label} tag=${tag} err=${msg}`);
      throw err;
    }
  });

  // Advance the queue. Swallow rejection on the gate side so the next
  // caller isn't poisoned by a prior failure; the rejection still
  // surfaces to the awaiting caller below via `myTurn`.
  txGate = myTurn.catch(() => {});

  return myTurn;
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
