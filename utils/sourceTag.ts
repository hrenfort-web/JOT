// Source tag for BQE time-entry analytics.
//
// We append a short hash-prefixed tag to the `description` field on every
// /timeentry write so the entry-mode mix (scan vs manual) is queryable
// BQE-side via a `description LIKE '%#js%'` filter — no in-app
// aggregation needed for the Studio G pilot.
//
// Quality Floor (jot-product-spec §1):
// - The tag never touches the `memo` field. memo is user content, PM-
//   reviewed, occasionally invoice-visible at firms that surface it. We
//   leave it alone.
// - The tag is 3 characters total ('#js' or '#jm'), short enough to be
//   visually unobtrusive even if Studio G's invoice template happens to
//   render the description column.
// - No visible Jot branding. The tag reads as opaque metadata.
//
// All write paths centralise here via `applySourceTag`. The matching
// parser (`parseSourceTag`) is used by `persistFetchedEntries` on
// read-back so re-installed devices recover the original source instead
// of mis-attributing every fetched entry as 'manual'.

import type { EntrySource } from '../db/schema';

const TAG_SCAN = '#js';
const TAG_MANUAL = '#jm';

// Non-global so .exec() / .match() return deterministic results.
const FIND_TAG = /#(js|jm)\b/;

// Global with optional leading whitespace so stripping removes the tag
// AND any space-separator before it without leaving a double-space.
const STRIP_TAG = /\s*#(js|jm)\b/g;

function tagFor(source: EntrySource): string | null {
  switch (source) {
    case 'scanned':
      return TAG_SCAN;
    case 'manual':
      return TAG_MANUAL;
    // 'voice' and 'prefilled' aren't shipped yet. Returning null here
    // means those entries get no tag for now — when they ship, add the
    // tag literal at the top of this file and a case here, and every
    // call site picks it up automatically.
    case 'voice':
    case 'prefilled':
    default:
      return null;
  }
}

/**
 * Append the source tag to a description value. Idempotent for the same
 * source (re-applying produces the same string). If the value already
 * has a different-source tag, the old one is stripped before the new
 * one is appended — protects against the create → edit → re-edit chain
 * accidentally accumulating tags.
 *
 * When `value` is empty after stripping, returns the bare tag.
 */
export function applySourceTag(value: string, source: EntrySource): string {
  const wantedTag = tagFor(source);
  if (wantedTag === null) return value ?? '';

  const input = value ?? '';
  // Strip every existing tag (handles same-source idempotency AND
  // different-source replacement in one pass). Collapse any double
  // spaces left behind from a mid-string tag and trim the ends.
  const stripped = input.replace(STRIP_TAG, '').replace(/\s+/g, ' ').trim();

  if (stripped.length === 0) return wantedTag;
  return `${stripped} ${wantedTag}`;
}

/**
 * Read the source tag out of a value. Returns the EntrySource it
 * encodes, or null if no recognised tag is present. Used by
 * `persistFetchedEntries` to recover the original source on read-back
 * (otherwise re-installed devices would mark every fetched entry as
 * 'manual', losing the scan/manual mix in local analytics).
 */
export function parseSourceTag(value: string | null | undefined): EntrySource | null {
  if (!value) return null;
  const match = FIND_TAG.exec(value);
  if (!match) return null;
  switch (match[1]) {
    case 'js':
      return 'scanned';
    case 'jm':
      return 'manual';
    default:
      return null;
  }
}
