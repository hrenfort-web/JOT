import type { LocalProject, LocalTimeEntry } from '../../db/schema';
import { isAllowedContractType } from '../bqe/project';
import { recentProjectParentIds } from '../../utils/projectSort';

export interface PhaseLookup {
  code: string | null;
  name: string;
  phaseProjectId: string;
}

export interface ProjectLookupEntry {
  projectName: string;
  projectId: string;
  shortcuts: string[];
  phases: PhaseLookup[];
}

export function buildProjectLookup(projects: LocalProject[]): ProjectLookupEntry[] {
  // Match the tree-builder rules: surface only phases the user is allowed to
  // log against, and skip parents that have no allowed phases AND aren't
  // themselves allowed (e.g. Reimbursable rollups). This keeps Claude's scan
  // matcher from suggesting projects the submission API would reject.
  const tops = projects.filter((p) => !p.isPhase && p.isActive);
  const phasesByParent = new Map<string, LocalProject[]>();
  for (const p of projects) {
    if (p.isPhase && p.isActive && p.parentId && isAllowedContractType(p)) {
      const list = phasesByParent.get(p.parentId) ?? [];
      list.push(p);
      phasesByParent.set(p.parentId, list);
    }
  }

  return tops
    .filter((top) => {
      const children = phasesByParent.get(top.id);
      if (children && children.length > 0) return true;
      return isAllowedContractType(top);
    })
    .map<ProjectLookupEntry>((top) => {
      const children = phasesByParent.get(top.id) ?? [];
      const phases: PhaseLookup[] = children.map((ph) => ({
        code: ph.phaseCode,
        name: ph.name,
        phaseProjectId: ph.id,
      }));
      if (phases.length === 0) {
        phases.push({ code: null, name: top.name, phaseProjectId: top.id });
      }
      return {
        projectName: top.name,
        projectId: top.id,
        shortcuts: deriveShortcuts(top.name, top.code),
        phases,
      };
    })
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

function deriveShortcuts(name: string, code: string | null): string[] {
  const out = new Set<string>();
  const trimmed = name.trim();
  if (!trimmed) return [];

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words[0]) out.add(words[0]);
  if (words.length >= 2) out.add(words.slice(0, 2).join(' '));

  const initials = words
    .map((w) => w[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  if (initials.length >= 2 && initials.length <= 5) out.add(initials);

  const firstWord = words[0];
  if (firstWord && firstWord.length >= 4) {
    out.add(firstWord.slice(0, 3));
  }

  if (code) out.add(code);

  return Array.from(out);
}

export function lookupTableToPromptString(entries: ProjectLookupEntry[]): string {
  const lines: string[] = [];
  lines.push('| Shorthand | Full Name | Project ID | Phase | Phase ID |');
  lines.push('|---|---|---|---|---|');
  for (const entry of entries) {
    const shortcuts = entry.shortcuts.join(', ') || entry.projectName;
    for (const phase of entry.phases) {
      const phaseLabel = phase.code ?? phase.name;
      lines.push(
        `| ${shortcuts} | ${entry.projectName} | ${entry.projectId} | ${phaseLabel} | ${phase.phaseProjectId} |`,
      );
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scan-prompt filtering.
//
// The Anthropic prompt's project lookup table dominates the token budget for
// every scan — at Studio G's ~347 parents × ~5 phases each it's ~70-80K
// input tokens. That's expensive AND degrades match accuracy: too many
// candidates and the model picks poor matches (see the Marketing→Services
// misclassification from the first device test).
//
// `buildScanLookup` ships a filtered subset to the model:
//   • parents the user has logged time to in the last 90 days (canonical
//     "recent" definition, same as the home picker), AND
//   • parents flagged as Marketing (contractType 3) or Overhead (contractType
//     4) — firm-wide staples like Office, Meetings, PTO. Always included.
//
// With a hard cap at 60 parents (top-50 by recency + overhead, then slice)
// to bound worst-case prompt size for power users.
//
// Brand-new projects the user hasn't charged time to yet won't appear in
// the filtered set. The flag-and-fix path on the review screen catches
// those — the AI returns a low-confidence flag, the user picks from the
// full project list via the existing editor.
// ---------------------------------------------------------------------------

const MAX_LOOKUP_PARENTS_DEFAULT = 60;
const MAX_RECENT_PARENTS_DEFAULT = 50;
const SCAN_RECENT_DAYS_DEFAULT = 90;

// BQE ContractType enum values that mark a project as overhead/admin work
// rather than billable client work. Defined in services/bqe/project.ts as
// the firm-agnostic structural signal.
const OVERHEAD_CONTRACT_TYPES = new Set<number>([3, 4]);

function isOverheadProject(p: LocalProject): boolean {
  return p.contractType != null && OVERHEAD_CONTRACT_TYPES.has(p.contractType);
}

export interface ScanLookupDebug {
  /** Active parents in the firm-wide project cache (before any filter). */
  totalParents: number;
  /** Parents the user logged time to within the window. */
  recentCount: number;
  /** Parents tagged as Marketing/Overhead, regardless of recency. */
  overheadCount: number;
  /** Parents selected after dedup but before the cap. */
  selectedParents: number;
  /** True when the cap trimmed at least one parent off the tail. */
  capped: boolean;
  /** Parents actually shipped in the prompt. */
  finalParents: number;
  /** Total phase rows in the final markdown table. */
  phaseCount: number;
  /** Rough input-token estimate for the lookup table portion only. */
  estimatedTokens: number;
}

export interface BuildScanLookupOptions {
  maxParents?: number;
  maxRecent?: number;
  recentDays?: number;
}

export function buildScanLookup(
  projects: LocalProject[],
  recentEntries: LocalTimeEntry[],
  currentUserResourceId: string,
  options?: BuildScanLookupOptions,
): { lookup: ProjectLookupEntry[]; debug: ScanLookupDebug } {
  const maxParents = options?.maxParents ?? MAX_LOOKUP_PARENTS_DEFAULT;
  const maxRecent = options?.maxRecent ?? MAX_RECENT_PARENTS_DEFAULT;
  const recentDays = options?.recentDays ?? SCAN_RECENT_DAYS_DEFAULT;

  // Step 1: canonical "recent" set — same definition the home picker uses
  // so a parent's appearance in scan filtering mirrors its appearance in
  // the home "Recent projects" list.
  const recentSet = recentProjectParentIds(
    projects,
    recentEntries,
    currentUserResourceId,
    recentDays,
  );

  // Step 2: per-parent recency timestamp, for top-K ranking under the cap.
  // Logic mirrors recentProjectParentIds (same cutoff, same user filter,
  // same phase→parent walk) but tracks the latest entry timestamp so we
  // can rank "more recent first" rather than just set-membership. Kept
  // inline to avoid widening projectSort's public surface for a single
  // caller.
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  const byId = new Map<string, LocalProject>();
  for (const p of projects) byId.set(p.id, p);
  const recencyByParent = new Map<string, number>();
  for (const e of recentEntries) {
    if (e.resourceId !== currentUserResourceId) continue;
    const t = new Date(e.date).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const proj = byId.get(e.projectId);
    if (!proj) continue;
    const parentId = proj.parentId ?? proj.id;
    if (!recentSet.has(parentId)) continue;
    const existing = recencyByParent.get(parentId);
    if (existing == null || t > existing) {
      recencyByParent.set(parentId, t);
    }
  }

  // Active parents only. The recency map can contain ids that have since
  // been deactivated in BQE — those would be useless in the prompt.
  const allActiveParents = projects.filter(
    (p) => p.parentId == null && p.isActive,
  );

  // Step 3: recent parents, ordered most-recent first, trimmed to maxRecent.
  const recentParents = allActiveParents
    .filter((p) => recencyByParent.has(p.id))
    .sort(
      (a, b) =>
        (recencyByParent.get(b.id) ?? 0) - (recencyByParent.get(a.id) ?? 0),
    );
  const recentTop = recentParents.slice(0, maxRecent);
  const recentTopIds = new Set(recentTop.map((p) => p.id));

  // Step 4: overhead parents (always-included). Dedup against recentTop
  // so a project that's both recent AND overhead isn't double-counted.
  const overheadAll = allActiveParents.filter(isOverheadProject);
  const overheadOnly = overheadAll.filter((p) => !recentTopIds.has(p.id));

  // Step 5: union with recent first (preserves recency ordering through
  // a stable slice), overhead appended, then hard cap. The cap trims off
  // the tail — which is overhead-only — when a firm has unusually many
  // overhead categories. Studio G has ~10, so this almost never triggers
  // in practice.
  const combined = [...recentTop, ...overheadOnly];
  const capped = combined.length > maxParents;
  const finalParents = capped ? combined.slice(0, maxParents) : combined;
  const finalIds = new Set(finalParents.map((p) => p.id));

  // Filter to selected parents + phases-of-selected-parents. Phases of
  // unselected parents disappear. buildProjectLookup will further drop
  // anything that fails its isAllowedContractType check — that's fine,
  // overhead parents (3, 4) are both in the allowed set.
  const filtered = projects.filter((p) => {
    if (p.parentId == null) return finalIds.has(p.id);
    return finalIds.has(p.parentId);
  });

  const lookup = buildProjectLookup(filtered);

  // Diagnostics — counted post-buildProjectLookup so the totals reflect
  // what's actually in the prompt, not what we asked for. (Edge case: a
  // parent with all phases disallowed and itself disallowed would be
  // dropped by buildProjectLookup, shrinking finalParents in practice.)
  const phaseCount = lookup.reduce((sum, e) => sum + e.phases.length, 0);
  // Rough token estimate: ~40 tokens per row (two UUIDs dominate at ~10
  // tokens each), plus ~200 tokens for the markdown header and column
  // separators. Approximate — for spotting regressions, not budgeting.
  const estimatedTokens = phaseCount * 40 + 200;

  return {
    lookup,
    debug: {
      totalParents: allActiveParents.length,
      recentCount: recentParents.length,
      overheadCount: overheadAll.length,
      selectedParents: combined.length,
      capped,
      finalParents: finalParents.length,
      phaseCount,
      estimatedTokens,
    },
  };
}
