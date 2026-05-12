import { create } from 'zustand';
import {
  ProjectNode,
  buildProjectHierarchy,
  isAllowedContractType,
  loadProjects,
} from '../services/bqe/project';
import { loadActivities } from '../services/bqe/activity';
import { getAll } from '../db/database';
import {
  groupFromRow,
  type LocalActivity,
  type LocalGroup,
  type LocalGroupRow,
  type LocalProject,
  type LocalProjectActivityGroup,
  type LocalProjectActivityGroupRow,
} from '../db/schema';
import { loadFirmSettings, seedFirmSettingsIfStale } from '../services/firmSettings';

async function loadGroups(): Promise<LocalGroup[]> {
  const rows = await getAll<LocalGroupRow>('SELECT * FROM LocalGroup');
  return rows.map(groupFromRow);
}

async function loadProjectActivityGroups(): Promise<LocalProjectActivityGroup[]> {
  // Direct row → object copy. The TS row type already matches the column
  // shape, so no row-mapper helper is needed (compare LocalGroup which
  // parses a JSON string column).
  return getAll<LocalProjectActivityGroupRow>(
    'SELECT * FROM LocalProjectActivityGroup',
  );
}

interface ProjectState {
  flatProjects: LocalProject[];
  tree: ProjectNode[];
  activities: LocalActivity[];
  groups: LocalGroup[];
  projectActivityGroups: LocalProjectActivityGroup[];
  /** Mirror of LocalFirmSettings rows. Updated on `refresh()`. */
  firmSettings: Record<string, string>;
  isLoading: boolean;
  lastError: string | null;

  refresh: () => Promise<void>;
  getProjectPhases: (parentId: string) => LocalProject[];
  getActiveProjects: () => ProjectNode[];
  getUserProjects: (resourceId: string) => ProjectNode[];
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  flatProjects: [],
  tree: [],
  activities: [],
  groups: [],
  projectActivityGroups: [],
  firmSettings: {},
  isLoading: false,
  lastError: null,

  refresh: async () => {
    set({ isLoading: true, lastError: null });
    try {
      // Ensure the versioned firm-settings seed is current before the
      // in-memory mirror is hydrated. Cheap when up-to-date (one SELECT);
      // writes the payload only when the stored version is behind. Wrapped
      // in try/catch so a transient DB hiccup never blocks the rest of
      // refresh — the resolver falls back to first-billable-in-group.
      try {
        await seedFirmSettingsIfStale();
      } catch (e) {
        if (__DEV__) {
          console.log(
            '[jot:store] firm-settings seed FAILED (non-fatal):',
            e instanceof Error ? e.message : e,
          );
        }
      }
      const [flat, activities, groups, projectActivityGroups, firmSettings] =
        await Promise.all([
          loadProjects(),
          loadActivities(),
          loadGroups(),
          loadProjectActivityGroups(),
          loadFirmSettings(),
        ]);
      set({
        flatProjects: flat,
        tree: buildProjectHierarchy(flat),
        activities,
        groups,
        projectActivityGroups,
        firmSettings,
        isLoading: false,
      });
    } catch (e) {
      set({
        isLoading: false,
        lastError: e instanceof Error ? e.message : 'Failed to load projects',
      });
    }
  },

  getProjectPhases: (parentId) =>
    get().flatProjects.filter(
      (p) => p.isPhase && p.parentId === parentId && isAllowedContractType(p),
    ),

  getActiveProjects: () => get().tree.filter((n) => n.project.isActive),

  getUserProjects: (_resourceId) => get().tree.filter((n) => n.project.isActive),
}));

// NOTE: getDefaultActivityId() was removed. Every entry-creation surface now
// calls services/activitySelection/resolver.ts::resolveActivityForEntry()
// directly. That function reads from this store via useProjectStore.getState()
// to stay synchronous. See the resolver file for the v2 picker hook contract.
