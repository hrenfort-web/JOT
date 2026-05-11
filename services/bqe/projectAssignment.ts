// [DEPRECATED FOR ACTIVITY SELECTION — kept for forward compat]
//
// /projectassignment was our first attempt at finding "which activities are
// allowed per project". It works for some BQE tenants but Studio G's tenant
// returns zero rows from this endpoint — they use the activity-group model
// instead (see services/bqe/projectActivities.ts + services/bqe/group.ts).
//
// We still call this sync during initialSync to keep LocalProject.groupId
// populated where BQE provides data. That column is no longer read by the
// activity resolver (services/activitySelection/resolver.ts) but a future
// firm might need it again. Safe to remove if confirmed unused after
// broader rollout.
//
// Docs: https://api-explorer.bqecore.com/docs/api/apis/projectassignment
//
// FIELD-NAME UNCERTAINTY: The exact JSON keys BQE returns aren't pinned down
// in the docs we have on hand. The expected keys are `projectId` and
// `groupId`, but BQE has historically shipped variants across endpoints
// (`project.id`, `project_id`, `activityGroupId`, etc.). On the first sync
// per app launch we log the raw shape under `[jot:assignment-shape]` so we
// can confirm field names from real responses and tighten this code later.

import { fetchAllPages } from './client';
import { run } from '../../db/database';

export interface BqeProjectAssignmentRaw {
  // Declared loosely on purpose — BQE may return camelCase, snake_case, or
  // nested objects. `extractProjectId` / `extractGroupId` handle the variants.
  [key: string]: unknown;
}

export interface ProjectAssignment {
  projectId: string;
  groupId: string | null;
}

const ASSIGNMENT_FIELDS =
  // Comma-separated to broaden the chance one of these is what BQE actually
  // serialises. The BQE API ignores unknown field names quietly.
  'id,projectId,groupId,activityGroupId,project,group';

// Studio G's tenant has 3,200+ projects → 3,200+ assignment rows. Page size
// matches what we use for /project to keep network behaviour predictable.
const PAGE_SIZE = 1000;

let shapeLogged = false;

export async function fetchProjectAssignments(): Promise<ProjectAssignment[]> {
  shapeLogged = false; // log shape once per fresh fetch cycle
  const raw = await fetchAllPages<BqeProjectAssignmentRaw>(
    '/projectassignment',
    { fields: ASSIGNMENT_FIELDS },
    { pageSize: PAGE_SIZE },
  );

  const out: ProjectAssignment[] = [];
  for (const row of raw) {
    if (!shapeLogged) {
      logFirstShape(row);
      shapeLogged = true;
    }
    const projectId = extractProjectId(row);
    if (!projectId) continue;
    out.push({
      projectId,
      groupId: extractGroupId(row),
    });
  }

  if (__DEV__) {
    const withGroup = out.filter((a) => a.groupId !== null).length;
    console.log(
      `[jot:assignment] parsed ${out.length} assignments (${withGroup} with groupId, ${out.length - withGroup} without)`,
    );
  }

  return out;
}

function logFirstShape(row: BqeProjectAssignmentRaw): void {
  // Always log on the first row of every fetch — even in release builds.
  // This is a measurement aid, not chatty debug noise, and the field-name
  // confirmation cycle is short-lived.
  console.log(
    '[jot:assignment-shape] first row keys =',
    Object.keys(row),
  );
  // Truncate to keep the console line readable but still useful for shape
  // diagnosis. 600 chars typically captures every top-level field plus a
  // couple of nested objects.
  try {
    console.log(
      '[jot:assignment-shape] first row =',
      JSON.stringify(row).slice(0, 600),
    );
  } catch {
    console.log('[jot:assignment-shape] first row = <unserializable>');
  }
}

function extractProjectId(row: BqeProjectAssignmentRaw): string | null {
  const direct = (row.projectId ?? row.project_id ?? row.projectID) as
    | string
    | undefined;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const nested = row.project as { id?: string } | undefined;
  if (nested && typeof nested.id === 'string' && nested.id.length > 0) {
    return nested.id;
  }
  return null;
}

function extractGroupId(row: BqeProjectAssignmentRaw): string | null {
  const direct = (row.groupId ??
    row.group_id ??
    row.activityGroupId ??
    row.activity_group_id) as string | undefined;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const nested = row.group as { id?: string } | undefined;
  if (nested && typeof nested.id === 'string' && nested.id.length > 0) {
    return nested.id;
  }
  return null;
}

/**
 * Writes each assignment's groupId onto its LocalProject row. Updates only —
 * does NOT insert new project rows. If an assignment references a project we
 * don't have locally (e.g. inactive, filtered out earlier), the UPDATE is a
 * no-op rather than introducing an orphan row.
 */
export async function saveProjectAssignments(
  assignments: ProjectAssignment[],
): Promise<void> {
  if (assignments.length === 0) return;
  // SQLite has no batch UPDATE primitive, but db.run inside withTransactionAsync
  // is plenty fast for 3k rows (sub-second on real hardware). We call run() one
  // row at a time rather than building a CASE expression because the latter
  // hits SQLite's expression-tree depth limit at ~1k branches.
  for (const a of assignments) {
    await run('UPDATE LocalProject SET groupId = ? WHERE id = ?', [
      a.groupId,
      a.projectId,
    ]);
  }
}

export async function fetchAndSaveProjectAssignments(): Promise<number> {
  const assignments = await fetchProjectAssignments();
  await saveProjectAssignments(assignments);
  return assignments.length;
}

/** Unique non-null group ids from a list of assignments. */
export function uniqueGroupIds(assignments: ProjectAssignment[]): string[] {
  const set = new Set<string>();
  for (const a of assignments) {
    if (a.groupId) set.add(a.groupId);
  }
  return Array.from(set);
}
