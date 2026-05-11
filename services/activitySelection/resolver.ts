// Single resolver for "which activityId should this time entry carry?".
//
// Every entry-creation surface (manual, scanned, voice, prefill) calls
// `resolveActivityForEntry` so the selection logic lives in exactly one
// place. The function is synchronous — it reads from the in-memory mirror
// that useProjectStore.refresh() hydrates from SQLite. Callers don't await,
// don't fetch, don't think about LocalGroup vs LocalProjectActivityGroup.
//
// SELECTION RULES (in priority order):
//
//   1. If firm setting `activitySelectionMode === 'manual'` AND the caller
//      passed a `userSelectedActivityId`, use it — provided it's in the
//      project's allowed set. Otherwise log a warning and fall through.
//
//   2. Auto-pick from the project's allowed activity set:
//        a. First billable + active activity in the set → that.
//        b. First active activity in the set → that, with reason
//           'no-billable-in-group'.
//
//   3. Firm-wide fallback (first billable + active anywhere). This logs
//      `[jot:activity-fallback]` so misconfigured projects show up in the
//      Debug log buffer. Tagged source: 'firm-fallback'.
//
//   4. Nothing usable anywhere → { activityId: null, source: 'none' }.
//      The call site renders a user-friendly "no activity available"
//      error and the entry is not POSTed.
//
// v2 PICKER HOOK: when activitySelectionMode === 'manual', the entry
// screen surfaces an activity picker between Phase and Hours. The picker
// reads getActivitiesAllowedForProject(projectId) for the dropdown
// options, then passes the user's choice as `userSelectedActivityId`. No
// other code changes needed in call sites.

import { useProjectStore } from '../../store/useProjectStore';
import { FIRM_SETTING_KEYS, type ActivitySelectionMode } from '../firmSettings';
import type { LocalActivity, LocalProject } from '../../db/schema';

export interface ResolveActivityOptions {
  projectId: string;
  /** Only consulted when firm setting is 'manual'. v2 picker UI hook. */
  userSelectedActivityId?: string;
}

export type ActivitySource =
  | 'user-selected'
  | 'project-group'
  | 'firm-fallback'
  | 'none';

export interface ResolveActivityResult {
  activityId: string | null;
  source: ActivitySource;
  reason?: string;
}

export function resolveActivityForEntry(
  opts: ResolveActivityOptions,
): ResolveActivityResult {
  const state = useProjectStore.getState();
  const mode = readMode(state.firmSettings);

  // Step 1: user-selected override (manual mode only).
  if (mode === 'manual' && opts.userSelectedActivityId) {
    const allowed = getActivitiesAllowedForProject(opts.projectId, state);
    if (allowed.includes(opts.userSelectedActivityId)) {
      return {
        activityId: opts.userSelectedActivityId,
        source: 'user-selected',
      };
    }
    console.warn(
      '[jot:activity-resolver] user-selected activity',
      opts.userSelectedActivityId,
      'not in allowed set for project',
      opts.projectId,
      '— falling back to auto-pick',
    );
  }

  // Step 2: auto-pick from project's group(s).
  const allowed = getActivitiesAllowedForProject(opts.projectId, state);
  if (allowed.length > 0) {
    const byId = activityIndex(state.activities);
    // Pass 1: billable AND active.
    for (const aid of allowed) {
      const act = byId.get(aid);
      if (act?.isBillable && act?.isActive) {
        return { activityId: aid, source: 'project-group' };
      }
    }
    // Pass 2: just active (covers PTO/Holiday/Bereavement, which are
    // active but non-billable — better than failing the entry).
    for (const aid of allowed) {
      const act = byId.get(aid);
      if (act?.isActive) {
        return {
          activityId: aid,
          source: 'project-group',
          reason: 'no-billable-in-group',
        };
      }
    }
  }

  // Step 3: firm-wide fallback. Logs so we can spot under-synced projects
  // in the Debug → View Logs screen.
  const firmFallback = pickFirstBillable(state.activities);
  if (firmFallback) {
    console.warn(
      '[jot:activity-fallback] project',
      opts.projectId,
      'has no allowed activities synced — using firm-wide fallback',
      firmFallback,
    );
    return {
      activityId: firmFallback,
      source: 'firm-fallback',
      reason: allowed.length === 0 ? 'no-groups-synced' : 'no-billable-in-group',
    };
  }

  return { activityId: null, source: 'none', reason: 'no-activities-available' };
}

/**
 * Public utility: every activityId allowed for a project, deduped, ordered
 * by group (first group's activities first). Visible to v2 picker UI as
 * the source for the dropdown.
 *
 * Handles phase → parent climb: if the phase row has no
 * LocalProjectActivityGroup rows of its own, falls back to the parent's
 * groups. Activities that were deleted/deactivated post-sync are NOT
 * filtered out here — the resolver does that step.
 */
export function getActivitiesAllowedForProject(
  projectId: string,
  state: ResolverState = useProjectStore.getState(),
): string[] {
  const directGroupIds = state.projectActivityGroups
    .filter((b) => b.projectId === projectId)
    .map((b) => b.groupId);

  let groupIds = directGroupIds;
  if (groupIds.length === 0) {
    // Phase climb. Look up the project row to find its parent, then check
    // for groups assigned to the parent.
    const project = state.flatProjects.find((p) => p.id === projectId);
    if (project?.parentId) {
      groupIds = state.projectActivityGroups
        .filter((b) => b.projectId === project.parentId)
        .map((b) => b.groupId);
    }
  }

  if (groupIds.length === 0) return [];

  // Union activityIds across the project's groups, preserving order of
  // first appearance. The first group's activities surface first so a
  // future picker UI's default selection reflects BQE's group priority.
  const groupByIdMap = new Map<string, string[]>();
  for (const g of state.groups) groupByIdMap.set(g.id, g.activityIds);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const gid of groupIds) {
    const activityIds = groupByIdMap.get(gid);
    if (!activityIds) continue;
    for (const aid of activityIds) {
      if (!seen.has(aid)) {
        seen.add(aid);
        out.push(aid);
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

/** Subset of useProjectStore state the resolver needs. Kept narrow so the
 *  resolver can be exercised from tests without booting the whole store. */
interface ResolverState {
  flatProjects: LocalProject[];
  activities: LocalActivity[];
  groups: { id: string; activityIds: string[] }[];
  projectActivityGroups: { projectId: string; groupId: string }[];
  firmSettings: Record<string, string>;
}

function readMode(firmSettings: Record<string, string>): ActivitySelectionMode {
  const v = firmSettings[FIRM_SETTING_KEYS.ACTIVITY_SELECTION_MODE];
  return v === 'manual' ? 'manual' : 'auto';
}

function activityIndex(activities: LocalActivity[]): Map<string, LocalActivity> {
  const m = new Map<string, LocalActivity>();
  for (const a of activities) m.set(a.id, a);
  return m;
}

function pickFirstBillable(activities: LocalActivity[]): string | null {
  const billable = activities.find((a) => a.isBillable && a.isActive);
  return billable?.id ?? activities[0]?.id ?? null;
}
