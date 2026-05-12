// Single resolver for "which activityId should this time entry carry?".
//
// Every entry-creation surface (manual, scanned, voice, prefill) calls
// `resolveActivityForEntry` so the selection logic lives in exactly one
// place. The function is synchronous — it reads from the in-memory mirror
// that useProjectStore.refresh() hydrates from SQLite. Callers don't await,
// don't fetch, don't think about LocalGroup vs LocalProjectActivityGroup.
//
// BQE BINDING-SHAPE NUANCE
// ------------------------
// /project/{id}/activities returns a mix of two binding shapes,
// distinguished by `itemType`:
//   - itemType: 139 → the row's `itemId` is an ACTIVITY GROUP. Allowed
//                     activities are the union of that group's members
//                     (LocalGroup.activityIds).
//   - itemType: 1   → the row's `itemId` is a DIRECT ACTIVITY ID. That
//                     single activity is allowed for the project.
// Studio G uses both: most production projects bind to groups; the PTO
// and Holiday overhead projects bind directly to OP-PTO and OP-Holiday.
// Source-of-record for this discovery: bqe-test/investigate-overhead-pins.mjs
// (run 2026-05-12, see chat handoff for full results).
//
// LocalProjectActivityGroup stores the row's `itemType` for every binding;
// the resolver consults it to decide whether to expand the row through
// LocalGroup (139) or treat it as a direct activity (1).
//
// SELECTION RULES (in priority order):
//
//   1. User-selected override (manual mode only — v2 picker UI hook). The
//      caller passes `userSelectedActivityId` and the firm setting
//      `activitySelectionMode === 'manual'`. The override must be a
//      member of the project's allowed set. Logs a warning and falls
//      through if not.
//
//   2. Per-project pin from firm settings (`activityPinning.byProject`).
//      Validated: must exist in LocalActivity, isActive=true, AND be in
//      the project's allowed set (group expansions + direct activities).
//      Pin set but invalid → resolver logs and falls through.
//
//   3. Per-group pin from firm settings (`activityPinning.byGroup`).
//      Walks the project's GROUP bindings (itemType 139 only) in order
//      and returns the first pin whose activity exists in LocalActivity
//      and is active. Direct-activity bindings (itemType 1) are skipped
//      here — those project types are pinned via byProject.
//
//   4. Auto-pick from the project's allowed set:
//        a. First billable + active activity → that.
//        b. First active activity → that, with reason
//           'no-billable-in-group' (covers PTO/Holiday/Bereavement, which
//           are active but non-billable).
//
//   5. Firm-wide fallback (first billable + active anywhere). Logs
//      `[jot:activity-fallback]` so misconfigured projects show up in the
//      Debug log buffer.
//
//   6. Nothing usable anywhere → { activityId: null, source: 'none' }.
//      The call site renders a user-friendly "no activity available"
//      error and the entry is not POSTed.
//
// v2 PICKER HOOK: when activitySelectionMode === 'manual', the entry
// screen surfaces an activity picker between Phase and Hours. The picker
// reads getAllowedActivityIdsForProject(projectId) for the dropdown
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
  | 'project-pin'
  | 'group-pin'
  | 'project-group'
  | 'firm-fallback'
  | 'none';

export interface ResolveActivityResult {
  activityId: string | null;
  source: ActivitySource;
  reason?: string;
}

interface ActivityPinning {
  byGroup: Record<string, string>;
  byProject: Record<string, string>;
}

// itemType constants from BQE's /project/{id}/activities response. Anything
// other than these two is treated as unknown and logged.
const ITEM_TYPE_ACTIVITY_GROUP = 139;
const ITEM_TYPE_DIRECT_ACTIVITY = 1;

export function resolveActivityForEntry(
  opts: ResolveActivityOptions,
): ResolveActivityResult {
  const state = useProjectStore.getState();
  const mode = readMode(state.firmSettings);
  const pinning = readPinning(state.firmSettings);

  // Compute the project's allowed-activity context once. Reused across
  // every step below.
  const groupIds = getGroupIdsForProject(opts.projectId, state);
  const allowed = getAllowedActivityIdsForProject(opts.projectId, state);
  const byActivityId = activityIndex(state.activities);

  // Step 1: user-selected override (manual mode only).
  if (mode === 'manual' && opts.userSelectedActivityId) {
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

  // Step 2: per-project pin. Strict validation — a pin pointing at a
  // deleted activity, or an activity not in the project's allowed set,
  // is dropped (with a warning) rather than letting BQE issue a 409.
  const projectPin = pinning.byProject[opts.projectId];
  if (projectPin) {
    const pinActivity = byActivityId.get(projectPin);
    const pinActive = !!pinActivity?.isActive;
    const pinInAllowed = allowed.includes(projectPin);
    if (pinActive && pinInAllowed) {
      return { activityId: projectPin, source: 'project-pin' };
    }
    console.warn(
      '[jot:activity-resolver] project pin invalid for',
      opts.projectId,
      '— activity:',
      projectPin,
      'present in LocalActivity:',
      !!pinActivity,
      'active:',
      pinActive,
      'in project allowed set:',
      pinInAllowed,
      '— falling through to group pin / auto-pick',
    );
  }

  // Step 3: per-group pin. Walks the project's GROUP bindings (itemType
  // 139) in BQE order. Direct-activity bindings are skipped here — those
  // project types are pinned via byProject, not byGroup.
  for (const gid of groupIds) {
    const groupPin = pinning.byGroup[gid];
    if (!groupPin) continue;
    const pinActivity = byActivityId.get(groupPin);
    if (pinActivity?.isActive) {
      return { activityId: groupPin, source: 'group-pin' };
    }
    console.warn(
      '[jot:activity-resolver] group pin invalid for group',
      gid,
      '— activity:',
      groupPin,
      'present in LocalActivity:',
      !!pinActivity,
      'active:',
      !!pinActivity?.isActive,
      '— continuing to next group / auto-pick',
    );
  }

  // Step 4: auto-pick from project's allowed set.
  if (allowed.length > 0) {
    // Pass 1: billable AND active.
    for (const aid of allowed) {
      const act = byActivityId.get(aid);
      if (act?.isBillable && act?.isActive) {
        return { activityId: aid, source: 'project-group' };
      }
    }
    // Pass 2: just active (covers PTO/Holiday/Bereavement, which are
    // active but non-billable — better than failing the entry).
    for (const aid of allowed) {
      const act = byActivityId.get(aid);
      if (act?.isActive) {
        return {
          activityId: aid,
          source: 'project-group',
          reason: 'no-billable-in-group',
        };
      }
    }
  }

  // Step 5: firm-wide fallback. Logs so we can spot under-synced projects
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
 * Canonical "what activities can this project accept" set.
 *
 * Combines (a) the union of LocalGroup.activityIds across the project's
 * itemType=139 bindings, with (b) the direct activity IDs from the
 * project's itemType=1 bindings. Deduped. Walks the parent project's
 * bindings as a fallback when the requested projectId is a phase with no
 * direct bindings of its own.
 *
 * Visible to the v2 picker UI as the source for the dropdown.
 */
export function getAllowedActivityIdsForProject(
  projectId: string,
  state: ResolverState = useProjectStore.getState(),
): string[] {
  const groupIds = getGroupIdsForProject(projectId, state);
  const groupExpanded = unionActivityIdsForGroups(groupIds, state);
  const direct = getDirectActivityIdsForProject(projectId, state);

  // Dedupe via Set while preserving first-appearance order: group
  // expansions first (so the v2 picker's default selection reflects BQE's
  // group priority), then any direct activities that weren't already in
  // the group expansion.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const aid of groupExpanded) {
    if (!seen.has(aid)) {
      seen.add(aid);
      out.push(aid);
    }
  }
  for (const aid of direct) {
    if (!seen.has(aid)) {
      seen.add(aid);
      out.push(aid);
    }
  }
  return out;
}

/**
 * Alias for backward compatibility — getAllowedActivityIdsForProject is
 * the canonical name. Older call sites and documentation referencing the
 * legacy name (`getActivitiesAllowedForProject`) keep working.
 */
export const getActivitiesAllowedForProject = getAllowedActivityIdsForProject;

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

/** Subset of useProjectStore state the resolver needs. Kept narrow so the
 *  resolver can be exercised from tests without booting the whole store. */
interface ResolverState {
  flatProjects: LocalProject[];
  activities: LocalActivity[];
  groups: { id: string; activityIds: string[] }[];
  projectActivityGroups: {
    projectId: string;
    groupId: string;
    itemType: number | null;
    // `id` surfaced for the unknown-itemType warning so we can point at a
    // specific row in BQE rather than just a project id.
    id?: string;
  }[];
  firmSettings: Record<string, string>;
}

/**
 * GROUP-type binding IDs (itemType 139) for the project, with phase →
 * parent climb. Direct-activity bindings (itemType 1) are NOT returned —
 * those are not group pin targets and are handled via
 * getDirectActivityIdsForProject.
 *
 * Returned in BQE row order so callers walking pins or unioning
 * activities surface the first group's members first.
 */
function getGroupIdsForProject(
  projectId: string,
  state: ResolverState,
): string[] {
  // Dedupe — some projects (e.g. Marketing 0000.03) carry duplicate
  // bindings to the same activity group. The pin walk would otherwise
  // log the same invalid-pin warning multiple times for one gid, and
  // the group-expansion would do redundant Map lookups.
  const bindings = bindingsForProjectWithClimb(projectId, state);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bindings) {
    if (b.itemType === ITEM_TYPE_ACTIVITY_GROUP && !seen.has(b.groupId)) {
      seen.add(b.groupId);
      out.push(b.groupId);
    }
  }
  return out;
}

/**
 * DIRECT-activity binding IDs (itemType 1) for the project, with phase →
 * parent climb. The `groupId` column on these rows actually holds an
 * activityId (BQE's /project/{id}/activities returns both shapes under
 * the same `itemId` field).
 */
function getDirectActivityIdsForProject(
  projectId: string,
  state: ResolverState,
): string[] {
  const bindings = bindingsForProjectWithClimb(projectId, state);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bindings) {
    if (b.itemType === ITEM_TYPE_DIRECT_ACTIVITY) {
      if (!seen.has(b.groupId)) {
        seen.add(b.groupId);
        out.push(b.groupId);
      }
    }
  }
  return out;
}

/**
 * Bindings rows from LocalProjectActivityGroup for the given projectId.
 * Falls back to the parent project's rows when the phase has none of its
 * own. Filters out unknown itemTypes (logging a warning) so a future BQE
 * schema surprise doesn't silently widen the allowed set.
 */
function bindingsForProjectWithClimb(
  projectId: string,
  state: ResolverState,
): ResolverState['projectActivityGroups'] {
  const direct = state.projectActivityGroups.filter((b) => b.projectId === projectId);
  const source = direct.length > 0
    ? direct
    : (() => {
        const project = state.flatProjects.find((p) => p.id === projectId);
        if (!project?.parentId) return [];
        return state.projectActivityGroups.filter((b) => b.projectId === project.parentId);
      })();

  const out: ResolverState['projectActivityGroups'] = [];
  for (const b of source) {
    if (
      b.itemType === ITEM_TYPE_ACTIVITY_GROUP ||
      b.itemType === ITEM_TYPE_DIRECT_ACTIVITY
    ) {
      out.push(b);
    } else if (b.itemType != null) {
      console.warn(
        '[jot:activity-resolver] unknown itemType on LocalProjectActivityGroup row',
        '— projectId:',
        b.projectId,
        'rowId:',
        b.id,
        'itemType:',
        b.itemType,
        'groupId:',
        b.groupId,
        '— skipping (treat as filed for follow-up)',
      );
    }
    // itemType === null is also skipped silently — older builds may have
    // written rows before the column existed. Re-sync hydrates them.
  }
  return out;
}

/**
 * Union activityIds across a list of GROUP IDs (itemType 139), preserving
 * order of first appearance. Used by getAllowedActivityIdsForProject.
 */
function unionActivityIdsForGroups(
  groupIds: string[],
  state: ResolverState,
): string[] {
  if (groupIds.length === 0) return [];
  const groupById = new Map<string, string[]>();
  for (const g of state.groups) groupById.set(g.id, g.activityIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const gid of groupIds) {
    const ids = groupById.get(gid);
    if (!ids) continue;
    for (const aid of ids) {
      if (!seen.has(aid)) {
        seen.add(aid);
        out.push(aid);
      }
    }
  }
  return out;
}

function readMode(firmSettings: Record<string, string>): ActivitySelectionMode {
  const v = firmSettings[FIRM_SETTING_KEYS.ACTIVITY_SELECTION_MODE];
  return v === 'manual' ? 'manual' : 'auto';
}

/**
 * Parse the activity-pinning JSON blob from firm settings. Defensive —
 * returns empty {byGroup, byProject} on any failure (missing key, corrupt
 * JSON, wrong shape). The resolver then falls through to the existing
 * auto-pick logic, which is the v1-without-pinning behavior.
 */
function readPinning(firmSettings: Record<string, string>): ActivityPinning {
  const raw = firmSettings[FIRM_SETTING_KEYS.ACTIVITY_PINNING];
  if (!raw) return { byGroup: {}, byProject: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<ActivityPinning> | null;
    return {
      byGroup:
        parsed && typeof parsed.byGroup === 'object' && parsed.byGroup !== null
          ? (parsed.byGroup as Record<string, string>)
          : {},
      byProject:
        parsed && typeof parsed.byProject === 'object' && parsed.byProject !== null
          ? (parsed.byProject as Record<string, string>)
          : {},
    };
  } catch {
    return { byGroup: {}, byProject: {} };
  }
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
