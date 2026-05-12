// ---------------------------------------------------------------------------
// Project-card dot palette + resolver.
//
// This file is the SINGLE SOURCE OF TRUTH for project dot colours at render
// time. Theme B intentionally moves the resolution from write-time (the old
// approach: compute once in saveProjects, persist into LocalProject.color)
// to read-time (compute every time we hydrate a LocalProject from its row).
//
// Why: caching the colour in SQLite meant a palette change in code didn't
// flow through to users until either initialSync re-ran (only fires when the
// cache is empty) or a forced migration nulled the column. Computing at read
// time makes any future palette refresh instant on next dev-client reload.
//
// LocalProject.color stays in the schema as a legacy column. saveProjects
// still writes into it for back-compat with any path that might still SELECT
// the column directly (e.g. an old query that bypasses projectFromRow), but
// projectFromRow IGNORES the column and recomputes via colorForId(row.id).
// Drop the column in a future cleanup pass if/when we're confident nothing
// reads it raw.
//
// The palette itself: muted earthy swatches that sit naturally against the
// cream background (#FAF6EE). The first slot is the brand accent — projects
// whose ID hash lands there share the brand colour. That's fine; the dot is
// identity, not chrome.
//
// Lives in utils/ (rather than services/bqe/) because db/schema.ts needs to
// reach it from projectFromRow, and services/bqe/project.ts already imports
// projectFromRow — a back-edge from schema.ts → services/bqe would cycle.
// utils/ has no project-domain imports, so it's safe for both ends to use.
// ---------------------------------------------------------------------------

export const PROJECT_COLORS = [
  '#C75D2C', // Terracotta (accent)
  '#8B6B4F', // Warm brown
  '#B89B5E', // Ochre
  '#7A8B6B', // Sage green
  '#4F6B6B', // Deep teal
  '#6B5E7A', // Dusty plum
  '#C9876F', // Dusty coral
  '#4F5B6B', // Slate blue
  '#8B4F4F', // Brick red
  '#5E7A8B', // Steel blue
];

/**
 * Deterministic colour for a project id. Same id → same swatch across cold
 * starts, devices, and palette refactors (as long as the palette length
 * doesn't change — see note below).
 *
 * Used in two places:
 *   1. projectFromRow (db/schema.ts) — read-time, the live source of truth.
 *   2. saveProjects (services/bqe/project.ts) — write-time, retained only so
 *      the legacy LocalProject.color column stays populated for any reader I
 *      might have missed. The read path doesn't trust this value.
 *
 * Caveat: changing PROJECT_COLORS.length will shift which projects get which
 * swatch (because the modulus changes). That's a cosmetic-only shift — no
 * data loss — but worth knowing if you reorder/extend the palette.
 */
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}
