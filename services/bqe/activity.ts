import { fetchAllPages } from './client';
import { upsertMany, sqliteBool, getAll } from '../../db/database';
import { LocalActivity, LocalActivityRow, activityFromRow } from '../../db/schema';

export interface BqeActivity {
  id: string;
  name?: string;
  displayName?: string;
  code?: string;
  billable?: boolean;
  isActive?: boolean;
}

export async function fetchActivities(): Promise<BqeActivity[]> {
  return fetchAllPages<BqeActivity>('/activity', {
    where: 'isActive=true',
    fields: 'id,name,code,billable',
  });
}

export async function saveActivities(activities: BqeActivity[]): Promise<void> {
  const rows = activities.map((a) => [
    a.id,
    a.name ?? a.displayName ?? '(unnamed)',
    a.code ?? null,
    sqliteBool(a.billable ?? true),
    sqliteBool(a.isActive ?? true),
  ]);
  await upsertMany(
    'LocalActivity',
    ['id', 'name', 'code', 'isBillable', 'isActive'],
    rows,
    'id',
    'saveActivities',
  );
}

export async function fetchAndSaveActivities(): Promise<number> {
  const activities = await fetchActivities();
  await saveActivities(activities);
  return activities.length;
}

export async function loadActivities(): Promise<LocalActivity[]> {
  const rows = await getAll<LocalActivityRow>(
    'SELECT * FROM LocalActivity WHERE isActive = 1 ORDER BY name ASC',
  );
  return rows.map(activityFromRow);
}
