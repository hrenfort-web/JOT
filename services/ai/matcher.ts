import type { LocalProject, LocalTimeEntry } from '../../db/schema';
import { isAllowedContractType } from '../bqe/project';

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
// Scan-prompt project lookup.
//
// `buildScanLookup` ships ALL active root projects to the model, ranked by
// per-user recency. Parents the user has charged time to within the recency
// window sort first (most recent first); parents the user has never charged
// sort to the bottom and only get dropped when the firm exceeds the cap.
//
// This is a RANK-not-FILTER design. Every real active project is matchable —
// projects the user hasn't yet charged still appear in the table (just lower
// down), so the model can match "Illumio" by name even on the user's first
// day on that project. The previous design filtered out non-recent parents
// outright, which surfaced as "the AI says my project doesn't exist" on a
// project the user simply hadn't logged against in 90 days.
//
// Token budget: at Studio G's ~80-120 active root projects × ~5 phases each
// the lookup table is ~10-20K input tokens. The default cap (60) is a
// conservative backstop for unknown firms; Studio G's firm setting raises
// it to 250 — effectively no cap at current size. If a future firm has
// thousands of active projects, lower their scanLookupOptions.maxParents
// firm setting; the recency-stalest parents drop first.
//
// Overhead projects (contractType 3 = Marketing, 4 = Overhead) no longer
// receive special force-include treatment. They rank by recency like every
// other project — which is fine because users actually log against them
// (OA-Admin, PTO, Holiday, Marketing all surface in the recent window for
// typical users). If a future firm regularly hits cap pressure where
// overhead is being stripped, raise that firm's maxParents rather than
// re-introducing a special case here.
// ---------------------------------------------------------------------------

const MAX_LOOKUP_PARENTS_DEFAULT = 60;
const SCAN_RECENT_DAYS_DEFAULT = 90;

// BQE ContractType enum values that mark a project as overhead/admin work
// rather than billable client work. Kept around for debug telemetry — the
// debug payload still reports how many active overhead parents exist in the
// pool, which is useful for on-device verification. No longer used as a
// filter / inclusion gate.
const OVERHEAD_CONTRACT_TYPES = new Set<number>([3, 4]);

function isOverheadProject(p: LocalProject): boolean {
  return p.contractType != null && OVERHEAD_CONTRACT_TYPES.has(p.contractType);
}

export interface ScanLookupDebug {
  /** Active root projects in the firm-wide project cache — the eligible pool. */
  totalParents: number;
  /** Active parents the user has charged time to within recentDays (informational). */
  recentCount: number;
  /** Active parents tagged Marketing/Overhead (informational). */
  overheadCount: number;
  /** True when totalParents exceeded maxParents and the tail was trimmed. */
  capped: boolean;
  /** Parents actually shipped in the prompt (== min(totalParents, maxParents)). */
  finalParents: number;
  /** Total phase rows in the final markdown table. */
  phaseCount: number;
  /** Rough input-token estimate for the lookup table portion only. */
  estimatedTokens: number;
}

export interface BuildScanLookupOptions {
  maxParents?: number;
  recentDays?: number;
}

export function buildScanLookup(
  projects: LocalProject[],
  recentEntries: LocalTimeEntry[],
  currentUserResourceId: string,
  options?: BuildScanLookupOptions,
): { lookup: ProjectLookupEntry[]; debug: ScanLookupDebug } {
  const maxParents = options?.maxParents ?? MAX_LOOKUP_PARENTS_DEFAULT;
  const recentDays = options?.recentDays ?? SCAN_RECENT_DAYS_DEFAULT;

  // Per-parent latest-entry timestamp for the current user. Pure RANKING
  // signal — anything within the cutoff contributes; anything older (or
  // never charged) gets no entry in this map and naturally sorts to the
  // bottom via the `?? 0` fallback in the comparator below. Explicitly
  // NOT a filter: every active parent is eligible regardless of presence
  // in this map.
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
    const existing = recencyByParent.get(parentId);
    if (existing == null || t > existing) {
      recencyByParent.set(parentId, t);
    }
  }

  // All active root projects are eligible. Rank by recency (recent first;
  // never-charged sinks to the bottom via the `?? 0` fallback), then cap.
  // The cap trims the stalest projects from the tail when a firm exceeds
  // maxParents — never-charged first, then oldest-charged.
  const allActiveParents = projects.filter(
    (p) => p.parentId == null && p.isActive,
  );
  const rankedParents = [...allActiveParents].sort(
    (a, b) =>
      (recencyByParent.get(b.id) ?? 0) - (recencyByParent.get(a.id) ?? 0),
  );

  const capped = rankedParents.length > maxParents;
  const finalParents = capped
    ? rankedParents.slice(0, maxParents)
    : rankedParents;
  const finalIds = new Set(finalParents.map((p) => p.id));

  // Filter the flat project list to selected parents + their phases.
  // Phases of unselected parents disappear. buildProjectLookup will
  // further drop anything that fails its isAllowedContractType check.
  const filtered = projects.filter((p) => {
    if (p.parentId == null) return finalIds.has(p.id);
    return finalIds.has(p.parentId);
  });

  const lookup = buildProjectLookup(filtered);

  // Diagnostics — counted post-buildProjectLookup so the totals reflect
  // what's actually in the prompt. recentCount/overheadCount are now
  // purely informational (neither is a filter input).
  const phaseCount = lookup.reduce((sum, e) => sum + e.phases.length, 0);
  const estimatedTokens = phaseCount * 40 + 200;
  const recentCount = allActiveParents.filter((p) =>
    recencyByParent.has(p.id),
  ).length;
  const overheadCount = allActiveParents.filter(isOverheadProject).length;

  return {
    lookup,
    debug: {
      totalParents: allActiveParents.length,
      recentCount,
      overheadCount,
      capped,
      finalParents: finalParents.length,
      phaseCount,
      estimatedTokens,
    },
  };
}
