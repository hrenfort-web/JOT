import type { LocalTimeEntry, LocalTimeEntryRow } from '../../db/schema';
import type { BqeTimeEntry } from '../bqe/timeentry';
import { toIsoDay } from '../bqe/utils';

// Pure predicate, no DB access. Both imports from services/bqe are
// type-only except toIsoDay (services/bqe/utils, which imports nothing
// back), so services/bqe/timeentry.ts can import this module without a
// runtime cycle.

/**
 * H-2 Option 1 fallback: recognise the server copy of a local create whose
 * outcome is unknown, so a retry never posts a second copy.
 *
 * The ONLY matcher. persistFetchedEntries (services/bqe/timeentry.ts)
 * applies it on every week fetch: a fetched entry that no local row already
 * carries as bqeId is compared against local rows with bqeId IS NULL,
 * createUncertain=1 and syncStatus pending or in_flight — rows whose create
 * request was sent (timeout, 5xx, killed process) but never confirmed. A
 * match is adopted in place (the local row takes the server id) instead of
 * being inserted as a second row. Because this runs inside the fetch path,
 * it applies whether the fetch was triggered by the queue's pre-POST
 * reconcile, by the home screen, or by a day rollover.
 *
 * Match rule: same projectId, activityId, calendar day, actualHours and
 * trimmed memo. Description is deliberately not compared — it carries the
 * source tag and is server-mutable.
 *
 * Accepted residual risk: two intentionally identical entries on one day
 * (same project, activity, hours and memo) where the first is already on
 * the server but NOT known locally by its id, and the second's create went
 * uncertain, would be treated as a retry of the first and collapsed into
 * one. When the first entry IS known locally (it was created here and has
 * its bqeId) the caller skips it, so the common in-app case is safe. BQE
 * research on 2026-09-25 (bqe-test/probe-idempotency*.mjs) found no
 * writable, filterable field on a time entry that could carry an exact
 * client key — the only filterable writable fields are three booleans, the
 * field named extra is a boolean, token is server-managed — and the
 * Idempotency-Key request header is ignored (two identical POSTs with one
 * key produced two entries). So an exact-key match is not possible and
 * field equality is the best available signal.
 */
export function isAdoptableMatch(
  row: Pick<LocalTimeEntryRow | LocalTimeEntry, 'projectId' | 'activityId' | 'date' | 'hours' | 'memo'>,
  remote: BqeTimeEntry,
): boolean {
  if (!remote.id) return false;
  if (remote.projectId !== row.projectId) return false;
  if (remote.activityId !== row.activityId) return false;
  if (toIsoDay(remote.date) !== toIsoDay(row.date)) return false;
  if (Number(remote.actualHours) !== row.hours) return false;
  if ((remote.memo ?? '').trim() !== (row.memo ?? '').trim()) return false;
  return true;
}
