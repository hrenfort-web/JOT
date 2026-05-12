import { fetchAllPages } from './client';
import { upsertMany, sqliteBool, getAll } from '../../db/database';
import {
  LocalProject,
  LocalProjectRow,
  projectFromRow,
} from '../../db/schema';
import { colorForId } from '../../utils/projectColors';

// Project-card dot palette + resolver have moved to utils/projectColors.
// The read path (projectFromRow) is now the source of truth — see that
// file's header for the rationale. saveProjects still calls colorForId
// below ONLY to keep the legacy LocalProject.color column populated for
// back-compat; the column is otherwise ignored at hydrate time.

const PHASE_NAME_REGEX = /[-–—:]\s*([A-Z]{1,4})\s*$/;
const PHASE_CODE_REGEX = /[-_/]([A-Z]{1,4})$/;

export interface BqeProject {
  id: string;
  name?: string;
  displayName?: string;
  code?: string;
  parentId?: string | null;
  parent?: { id?: string } | null;
  client?: { name?: string; displayName?: string } | string | null;
  status?: number | string;
  // BQE returns this as an integer enum, but in practice the API has been
  // observed to occasionally serialise enums as numeric strings ("4"). We
  // coerce to number before comparing in `isAllowedContractType`.
  contractType?: number | string | null;
}

// BQE confirmed (support email): /project has no isActive field. Status is a
// numeric enum and `status=0` means Active. Reference:
// https://api-explorer.bqecore.com/docs/api/apis/project
const PROJECT_BASE_FIELDS = 'id,name,code,parentId,client,status,contractType';
const STATUS_ACTIVE = 0;

// BQE Core ContractType enum (Studio G order):
//   0 = Hourly
//   1 = Fixed
//   2 = Hourly NTE (Not to Exceed)
//   3 = Marketing
//   4 = Overhead
//   5 = Percentage
//   6 = Recurring
//   7 = Recurring w Cap
//   8 = Recurring + Expenses
//   9 = Cost + Percentage
//  10 = Cost + Fixed Fee
//  11 = Recurring + Hourly
//
// Studio G logs time against Hourly, Fixed, Hourly NTE, Marketing, and
// Overhead. The remaining types either bill formulaically (Percentage,
// Recurring variants, Cost + …) or aren't time-entry surfaces for staff.
// This is firm-specific — if you fork Jot for another practice, edit this
// constant. The contract-type distribution is logged after the first sync
// (see logProjectDiagnostics) so you can verify the enum values match what
// your tenant actually returns.
export const ALLOWED_CONTRACT_TYPES: number[] = [0, 1, 2, 3, 4];

const ALLOWED_CONTRACT_TYPES_SET = new Set(ALLOWED_CONTRACT_TYPES);

/**
 * Returns true when the project's contractType is allowed for time entry.
 * - null/undefined is treated as allowed (safety default — we never hide
 *   rows whose enum we don't recognise; the firm sees them and can flag
 *   unexpected values rather than silently losing access).
 * - Numeric strings ("4") are coerced to numbers before comparison.
 * - Non-numeric values (NaN after coercion) are treated as allowed for the
 *   same safety reason.
 */
export function isAllowedContractType(p: {
  contractType: number | string | null | undefined;
}): boolean {
  if (p.contractType == null) return true;
  const n = Number(p.contractType);
  if (!Number.isFinite(n)) return true;
  return ALLOWED_CONTRACT_TYPES_SET.has(n);
}

export async function fetchProjects(): Promise<BqeProject[]> {
  const projects = await fetchAllPages<BqeProject>('/project', {
    where: `status=${STATUS_ACTIVE}`,
    fields: PROJECT_BASE_FIELDS,
  });
  if (__DEV__) logProjectDiagnostics(projects, `where=status=${STATUS_ACTIVE}`);
  return projects;
}

function logProjectDiagnostics(projects: BqeProject[], source: string): void {
  console.log('[jot:project] /project [' + source + '] returned', projects.length, 'rows');
  if (projects.length > 0) {
    console.log('[jot:project] sample row keys =', Object.keys(projects[0]));
    console.log('[jot:project] sample row =', JSON.stringify(projects[0]).slice(0, 400));
  }
  const distinct = new Map<string, number>();
  for (const p of projects) {
    const key = p.status !== undefined ? String(p.status) : '<missing>';
    distinct.set(key, (distinct.get(key) ?? 0) + 1);
  }
  console.log('[jot:project] status distribution =', Array.from(distinct.entries()));

  // Contract-type distribution. BQE returns this as a numeric enum (see
  // ALLOWED_CONTRACT_TYPES for the legend) — log keys both as the raw value
  // we received and as a coerced number, so a tenant that returns "4" vs 4
  // is obvious in the output, and so we can extend the allowed list if BQE
  // ever introduces a new enum value.
  const byContract = new Map<string, number>();
  for (const p of projects) {
    const raw = p.contractType;
    let key: string;
    if (raw == null) {
      key = '<missing>';
    } else {
      const n = Number(raw);
      key = Number.isFinite(n) ? String(n) : `<unparsed:${String(raw)}>`;
    }
    byContract.set(key, (byContract.get(key) ?? 0) + 1);
  }
  console.log(
    '[jot:project] contract type distribution =',
    Array.from(byContract.entries()),
  );
}

function extractPhaseCode(name: string | undefined, code: string | undefined): string | null {
  if (name) {
    const m = name.match(PHASE_NAME_REGEX);
    if (m) return m[1].toUpperCase();
  }
  if (code) {
    const m = code.match(PHASE_CODE_REGEX);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function clientName(client: BqeProject['client']): string | null {
  if (!client) return null;
  if (typeof client === 'string') return client;
  return client.name ?? client.displayName ?? null;
}

function parentIdOf(p: BqeProject): string | null {
  if (p.parentId) return p.parentId;
  if (p.parent?.id) return p.parent.id;
  return null;
}

export async function saveProjects(projects: BqeProject[]): Promise<void> {
  const now = new Date().toISOString();

  const sortedTopLevel = projects
    .filter((p) => parentIdOf(p) === null)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const sortIndex = new Map<string, number>();
  sortedTopLevel.forEach((p, i) => sortIndex.set(p.id, i));

  const rows = projects.map((p) => {
    const parent = parentIdOf(p);
    const isPhase = parent !== null;
    const name = p.name ?? p.displayName ?? '(unnamed)';
    // status === 0 (number) means Active per BQE. We also accept legacy string
    // 'active' just in case BQE ever returns a stringified enum.
    const active =
      p.status === 0 ||
      p.status === undefined ||
      (typeof p.status === 'string' && p.status.toLowerCase() === 'active');
    // Coerce contractType to a clean integer at the write boundary. If BQE
    // ever returns a non-numeric value the row keeps a NULL — same effect
    // as missing data — so the safety default in isAllowedContractType
    // applies and the project stays visible.
    let contractType: number | null = null;
    if (p.contractType != null) {
      const n = Number(p.contractType);
      contractType = Number.isFinite(n) ? n : null;
    }
    return [
      p.id,
      name,
      p.code ?? null,
      clientName(p.client),
      parent,
      sqliteBool(isPhase),
      isPhase ? extractPhaseCode(name, p.code) : null,
      sqliteBool(active),
      // Legacy: color is derived at read-time in projectFromRow. This write
      // is kept only so the column isn't NULL for back-compat with any read
      // path that might still SELECT it directly. Safe to drop in a future
      // cleanup if we're confident nothing reads it raw.
      isPhase ? null : colorForId(p.id),
      isPhase ? 0 : (sortIndex.get(p.id) ?? 0),
      now,
      contractType,
    ];
  });

  await upsertMany(
    'LocalProject',
    [
      'id',
      'name',
      'code',
      'clientName',
      'parentId',
      'isPhase',
      'phaseCode',
      'isActive',
      'color',
      'sortOrder',
      'lastSynced',
      'contractType',
    ],
    rows,
    'id',
  );
}

export async function fetchAndSaveProjects(): Promise<number> {
  const projects = await fetchProjects();
  await saveProjects(projects);
  return projects.length;
}

export async function loadProjects(): Promise<LocalProject[]> {
  const t0 = Date.now();
  const rows = await getAll<LocalProjectRow>(
    'SELECT * FROM LocalProject WHERE isActive = 1 ORDER BY isPhase ASC, sortOrder ASC, name ASC',
  );
  const out = rows.map(projectFromRow);
  if (__DEV__) {
    console.log(
      `[jot:project] loadProjects → ${out.length} active rows in ${Date.now() - t0}ms`,
    );
  }
  return out;
}

export interface ProjectNode {
  project: LocalProject;
  phases: LocalProject[];
}

export function buildProjectHierarchy(projects: LocalProject[]): ProjectNode[] {
  const t0 = Date.now();
  const tops = projects.filter((p) => !p.isPhase);
  const phasesByParent = new Map<string, LocalProject[]>();
  for (const p of projects) {
    if (p.isPhase && p.parentId && isAllowedContractType(p)) {
      const list = phasesByParent.get(p.parentId) ?? [];
      list.push(p);
      phasesByParent.set(p.parentId, list);
    }
  }
  for (const list of phasesByParent.values()) {
    list.sort((a, b) => (a.phaseCode ?? a.name).localeCompare(b.phaseCode ?? b.name));
  }
  // Drop parents whose own contract type is disallowed AND who have no allowed
  // phase children. Keeps "Reimbursable parent with a Fixed phase override"
  // working but hides "Reimbursable parent with all-Reimbursable phases".
  const tree = tops
    .filter((project) => {
      const phases = phasesByParent.get(project.id);
      if (phases && phases.length > 0) return true;
      return isAllowedContractType(project);
    })
    .map((project) => ({
      project,
      phases: phasesByParent.get(project.id) ?? [],
    }));
  if (__DEV__) {
    console.log(
      `[jot:project] buildProjectHierarchy → ${tree.length} parents from ${projects.length} rows in ${Date.now() - t0}ms`,
    );
  }
  return tree;
}
