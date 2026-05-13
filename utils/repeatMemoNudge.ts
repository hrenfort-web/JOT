// Repeat-memo soft nudge — Quality Floor §7.4.5.
//
// When a user has submitted the same memo 3+ times in the current week,
// the next chip tap for that memo doesn't auto-fill the memo field. The
// hours screen presents a "What specifically today?" placeholder and a
// one-line hint asking the user to either type something different or
// tap the chip a second time to confirm. The mechanism is in-memory and
// force-quit-safe — counts are queried fresh on each entry-screen mount.
//
// Match semantics: case-insensitive + whitespace-trimmed. Two memos
// counted as the same string after lowercasing both sides and trimming
// surrounding whitespace count toward the same threshold. Comma-appended
// composites ("Coordination, Email") get their own count distinct from
// either component — that's intentional, since the composite is a more
// specific memo than either part alone.

import { getAll } from '../db/database';

/**
 * Threshold at which a memo is considered "repeated this week" for a
 * given user. The 4th tap of a chip whose memo is already at or above
 * this count triggers the soft nudge.
 */
export const REPEAT_THRESHOLD = 3;

/**
 * How long the primed (interrupt-pending) state persists before
 * auto-clearing. 5s leaves enough headroom for the user to read the
 * placeholder swap + hint line and decide; longer than that and the
 * intent feels stale.
 */
export const REPEAT_TIMEOUT_MS = 5000;

/**
 * True when the count has reached the soft-nudge threshold. Returns
 * false for null/undefined/NaN counts so callers don't have to guard.
 */
export function isMemoRepeated(count: number | undefined | null): boolean {
  return typeof count === 'number' && count >= REPEAT_THRESHOLD;
}

/**
 * Canonical normalisation for memo matching. Single source of truth so
 * the caller (hours screen) and the SQL query agree on what "the same
 * memo" means.
 */
export function normalizeMemo(memo: string): string {
  return memo.trim().toLowerCase();
}

interface CountRow {
  key: string;
  n: number;
}

/**
 * Returns a Map<normalizedMemo, count> covering every chip memo passed
 * in. Memos absent from the map have count 0 (caller uses `?? 0`).
 *
 * Single SQL query — the IN clause holds N normalised placeholders, one
 * per distinct chip. Cheap even with the full 5-chip suggestion set;
 * scales linearly if chip count grows.
 *
 * The date column on LocalTimeEntry is stored as ISO yyyy-mm-dd, so
 * BETWEEN works as a lexicographic range over the week. The caller
 * passes Monday and Sunday of the current week as ISO strings.
 */
export async function getRepeatMemoCounts(
  userId: string,
  weekStartIso: string,
  weekEndIso: string,
  memos: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (memos.length === 0) return result;

  // Dedupe normalised memos before building the IN clause — a chip set
  // that happens to contain "Coordination" and "  coordination  " would
  // otherwise produce duplicate placeholders. Drop empty strings too;
  // they can't be at the threshold.
  const normalised = Array.from(new Set(memos.map(normalizeMemo))).filter(
    (m) => m.length > 0,
  );
  if (normalised.length === 0) return result;

  const placeholders = normalised.map(() => '?').join(',');
  const rows = await getAll<CountRow>(
    `SELECT LOWER(TRIM(memo)) AS key, COUNT(*) AS n
     FROM LocalTimeEntry
     WHERE resourceId = ?
       AND date BETWEEN ? AND ?
       AND memo IS NOT NULL
       AND LOWER(TRIM(memo)) IN (${placeholders})
     GROUP BY LOWER(TRIM(memo))`,
    [userId, weekStartIso, weekEndIso, ...normalised],
  );

  for (const row of rows) {
    result.set(row.key, row.n);
  }
  return result;
}
