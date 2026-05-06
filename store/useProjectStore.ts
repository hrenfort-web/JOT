import { create } from 'zustand';
import {
  ProjectNode,
  buildProjectHierarchy,
  loadProjects,
} from '../services/bqe/project';
import { loadActivities } from '../services/bqe/activity';
import type { LocalActivity, LocalProject } from '../db/schema';

interface ProjectState {
  flatProjects: LocalProject[];
  tree: ProjectNode[];
  activities: LocalActivity[];
  isLoading: boolean;
  lastError: string | null;

  refresh: () => Promise<void>;
  getProjectPhases: (parentId: string) => LocalProject[];
  getActiveProjects: () => ProjectNode[];
  getUserProjects: (resourceId: string) => ProjectNode[];
  getDefaultActivityId: () => string | null;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  flatProjects: [],
  tree: [],
  activities: [],
  isLoading: false,
  lastError: null,

  refresh: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const [flat, activities] = await Promise.all([loadProjects(), loadActivities()]);
      set({
        flatProjects: flat,
        tree: buildProjectHierarchy(flat),
        activities,
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
    get().flatProjects.filter((p) => p.isPhase && p.parentId === parentId),

  getActiveProjects: () => get().tree.filter((n) => n.project.isActive),

  getUserProjects: (_resourceId) => get().tree.filter((n) => n.project.isActive),

  getDefaultActivityId: () => {
    const billable = get().activities.find((a) => a.isBillable && a.isActive);
    return billable?.id ?? get().activities[0]?.id ?? null;
  },
}));
