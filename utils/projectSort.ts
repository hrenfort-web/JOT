// Picker sort order.
//
// Tier 1 (recent): parent projects the current user logged time against in
//                  the last `recentDays` days, sorted by most-recent-entry
//                  date desc.
// Tier 2 (other):  every remaining active parent project, sorted by parsed
//                  project number (year desc, then NNN desc). Projects with
//                  no parseable YYYY-NNN code sort alphabetically at the
//                  very bottom of tier 2.
//
// This replaces the prior alphabetical/bucketed sort that floated
// number-prefixed names to the top regardless of relevance.

import type { LocalProject, LocalTimeEntry } from '../db/schema';

export const DEFAULT_RECENT_DAYS = 90;

export function sortProjectsForPicker(
  projects: LocalProject[],
  entries: LocalTimeEntry[],
  currentUserResourceId: string,
  recentDays: number = DEFAULT_RECENT_DAYS,
): LocalProject[] {
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;

  // Build a project lookup once so the entry loop below stays O(N + M)
  // rather than O(N * M) — the prior version did a .find() per entry which
  // becomes hot when a user has thousands of entries.
  const byId = new Map<string, LocalProject>();
  for (const p of projects) byId.set(p.id, p);

  // parentProjectId -> most recent entry-date timestamp
  const recencyByParent = new Map<string, number>();
  for (const e of entries) {
    if (e.resourceId !== currentUserResourceId) continue;
    const entryTime = new Date(e.date).getTime();
    if (!Number.isFinite(entryTime) || entryTime < cutoff) continue;
    // Resolve to parent: if the entry's project is a phase, walk up to its
    // parent; otherwise the entry already lives on a top-level project.
    const proj = byId.get(e.projectId);
    if (!proj) continue;
    const parentId = proj.parentId ?? proj.id;
    const existing = recencyByParent.get(parentId);
    if (existing == null || entryTime > existing) {
      recencyByParent.set(parentId, entryTime);
    }
  }

  // Only top-level (parent) projects appear in the picker. Phases are
  // chosen on the next screen after a parent is picked.
  const parents = projects.filter((p) => p.parentId == null && p.isActive);

  const tier1 = parents
    .filter((p) => recencyByParent.has(p.id))
    .sort((a, b) => recencyByParent.get(b.id)! - recencyByParent.get(a.id)!);

  const tier2 = parents
    .filter((p) => !recencyByParent.has(p.id))
    .sort(compareByProjectNumber);

  return [...tier1, ...tier2];
}

/**
 * Exposed alongside the sort so the home screen can split its rendered
 * list into "recent" vs "other" without re-running the recency scan.
 * Returns the set of project ids that are tier 1.
 */
export function recentProjectParentIds(
  projects: LocalProject[],
  entries: LocalTimeEntry[],
  currentUserResourceId: string,
  recentDays: number = DEFAULT_RECENT_DAYS,
): Set<string> {
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  const byId = new Map<string, LocalProject>();
  for (const p of projects) byId.set(p.id, p);
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.resourceId !== currentUserResourceId) continue;
    const entryTime = new Date(e.date).getTime();
    if (!Number.isFinite(entryTime) || entryTime < cutoff) continue;
    const proj = byId.get(e.projectId);
    if (!proj) continue;
    ids.add(proj.parentId ?? proj.id);
  }
  return ids;
}

function parseProjectNumber(p: LocalProject): { year: number; num: number } | null {
  // Try `code` first because firms typically encode the year/number in
  // structured codes; `name` is a fallback when the code is missing or
  // when the firm uses naming like "2026-014 Smith Residence".
  const source = p.code ?? p.name ?? '';
  const m = source.match(/(\d{4})[-\s]*(\d+)/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), num: parseInt(m[2], 10) };
}

function compareByProjectNumber(a: LocalProject, b: LocalProject): number {
  const aNum = parseProjectNumber(a);
  const bNum = parseProjectNumber(b);
  // Both parseable: year desc, then num desc.
  if (aNum && bNum) {
    if (aNum.year !== bNum.year) return bNum.year - aNum.year;
    return bNum.num - aNum.num;
  }
  // One parseable, the other not: parseable comes first.
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  // Neither parseable: alphabetical by name.
  return a.name.localeCompare(b.name);
}
