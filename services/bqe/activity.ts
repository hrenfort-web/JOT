import { bqeClient } from './client';
import { unwrapList } from './utils';
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
  const response = await bqeClient.get('/activity', {
    params: {
      where: 'isActive=true',
      fields: 'id,name,code,billable',
      page: '1,1000',
    },
  });
  return unwrapList<BqeActivity>(response.data);
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
