import { bqeClient } from './client';
import { decodeIdTokenSub, StoredTokens } from './auth';
import { unwrapList } from './utils';
import { upsertMany, getAll } from '../../db/database';
import { LocalEmployee, LocalEmployeeRow } from '../../db/schema';

export interface BqeEmployee {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  billRate?: number;
  costRate?: number;
  status?: string;
  userId?: string;
  [key: string]: unknown;
}

export async function fetchCurrentEmployee(tokens: StoredTokens): Promise<BqeEmployee> {
  const sub = tokens.idToken ? decodeIdTokenSub(tokens.idToken) : null;

  const response = await bqeClient.get('/employee', {
    baseURL: tokens.endpoint,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'X-UTC-OFFSET': String(-new Date().getTimezoneOffset()),
    },
  });

  const employees = unwrapList<BqeEmployee>(response.data);

  if (sub) {
    const match = employees.find((e) => e.id === sub || e.userId === sub);
    if (match) return match;
  }
  if (employees.length === 0) {
    throw new Error('No employee profile returned from BQE');
  }
  return employees[0];
}

export async function fetchEmployees(): Promise<BqeEmployee[]> {
  const response = await bqeClient.get('/employee', {
    params: {
      fields: 'id,displayName,firstName,lastName,billRate,costRate,status',
      page: '1,1000',
    },
  });
  return unwrapList<BqeEmployee>(response.data);
}

export async function saveEmployees(employees: BqeEmployee[]): Promise<void> {
  const rows = employees.map((e) => [
    e.id,
    e.displayName ?? null,
    e.firstName ?? null,
    e.lastName ?? null,
    'staff',
    40,
  ]);
  await upsertMany(
    'LocalEmployee',
    ['id', 'displayName', 'firstName', 'lastName', 'role', 'standardHoursPerWeek'],
    rows,
    'id',
  );
}

export async function fetchAndSaveEmployees(): Promise<number> {
  const employees = await fetchEmployees();
  await saveEmployees(employees);
  return employees.length;
}

export async function loadEmployees(): Promise<LocalEmployee[]> {
  return getAll<LocalEmployeeRow>(
    'SELECT * FROM LocalEmployee ORDER BY displayName ASC',
  );
}
