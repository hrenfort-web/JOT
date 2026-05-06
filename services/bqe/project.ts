import { bqeClient } from './client';
import { unwrapList } from './utils';
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
  isActive?: boolean;
  status?: string;
}

export async function fetchProjects(): Promise<BqeProject[]> {
  const response = await bqeClient.get('/project', {
    params: {
      where: 'isActive=true',
      fields: 'id,name,code,parentId,client',
      page: '1,1000',
    },
  });
  return unwrapList<BqeProject>(response.data);
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
    return [
      p.id,
      name,
      p.code ?? null,
      clientName(p.client),
      parent,
      sqliteBool(isPhase),
      isPhase ? extractPhaseCode(name, p.code) : null,
      sqliteBool(p.isActive ?? true),
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
  const rows = await getAll<LocalProjectRow>(
    'SELECT * FROM LocalProject WHERE isActive = 1 ORDER BY isPhase ASC, sortOrder ASC, name ASC',
  );
  return rows.map(projectFromRow);
}

export interface ProjectNode {
  project: LocalProject;
  phases: LocalProject[];
}

export function buildProjectHierarchy(projects: LocalProject[]): ProjectNode[] {
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
  return tops.map((project) => ({
    project,
    phases: phasesByParent.get(project.id) ?? [],
  }));
}
