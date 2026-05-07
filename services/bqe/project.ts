import { fetchAllPages } from './client';
import { upsertMany, sqliteBool, getAll } from '../../db/database';
import {
  LocalProject,
  LocalProjectRow,
  projectFromRow,
} from '../../db/schema';

const PROJECT_COLORS = [
  '#1D9E75',
  '#3B82F6',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#EC4899',
  '#06B6D4',
  '#84CC16',
];

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
}

// BQE confirmed (support email): /project has no isActive field. Status is a
// numeric enum and `status=0` means Active. Reference:
// https://api-explorer.bqecore.com/docs/api/apis/project
const PROJECT_BASE_FIELDS = 'id,name,code,parentId,client,status';
const STATUS_ACTIVE = 0;

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
}

function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
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
    return [
      p.id,
      name,
      p.code ?? null,
      clientName(p.client),
      parent,
      sqliteBool(isPhase),
      isPhase ? extractPhaseCode(name, p.code) : null,
      sqliteBool(active),
      isPhase ? null : colorForId(p.id),
      isPhase ? 0 : (sortIndex.get(p.id) ?? 0),
      now,
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
    if (p.isPhase && p.parentId) {
      const list = phasesByParent.get(p.parentId) ?? [];
      list.push(p);
      phasesByParent.set(p.parentId, list);
    }
  }
  for (const list of phasesByParent.values()) {
    list.sort((a, b) => (a.phaseCode ?? a.name).localeCompare(b.phaseCode ?? b.name));
  }
  const tree = tops.map((project) => ({
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
