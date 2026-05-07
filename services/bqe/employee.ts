import type { AxiosResponse } from 'axios';
import { bqeClient, fetchAllPages } from './client';
import { decodeIdTokenSub, fetchUserInfo, StoredTokens } from './auth';
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

type AnyRow = Record<string, unknown>;

const FIRST_NAME_KEYS = ['firstName', 'FirstName', 'first_name'];
const LAST_NAME_KEYS = ['lastName', 'LastName', 'last_name'];
const DISPLAY_NAME_KEYS = ['displayName', 'DisplayName', 'fullName', 'FullName', 'name', 'Name'];
const EMAIL_KEYS = ['email', 'Email'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pickStr(row: AnyRow, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function stringFrom(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function authHeaders(tokens: StoredTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    'X-UTC-OFFSET': String(-new Date().getTimezoneOffset()),
  };
}

// Run one BQE employee-lookup attempt and normalize the response shape.
// Returns the matched employee, or null when not found / multi-match / errored.
async function tryLookup(
  description: string,
  request: () => Promise<AxiosResponse>,
): Promise<BqeEmployee | null> {
  if (__DEV__) console.log(`[jot:employee] try ${description}`);
  try {
    const resp = await request();
    if (resp.status === 204) {
      if (__DEV__) console.log('  →', '204 (no content)');
      return null;
    }
    const data = resp.data;
    // Wrapped list shapes: { value: [...] } / { data: [...] } / { items: [...] }
    const list = unwrapList<BqeEmployee>(data);
    if (list.length > 0) {
      if (__DEV__) console.log('  →', list.length, 'row(s)');
      if (list.length === 1) return list[0];
      if (__DEV__) {
        console.log('  →', 'multi-match — preview =', list.slice(0, 3).map((r) => ({
          id: (r as AnyRow).id,
          name: pickStr(r as AnyRow, DISPLAY_NAME_KEYS),
        })));
      }
      return list[0];
    }
    // Single-object response (path-style /employee/{id})
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const obj = data as AnyRow;
      if (typeof obj.id === 'string') {
        if (__DEV__) console.log('  →', 'single object →', obj.id);
        return obj as unknown as BqeEmployee;
      }
    }
    if (__DEV__) console.log('  →', '0 rows');
    return null;
  } catch (e) {
    const err = e as { response?: { status?: number; data?: unknown }; message?: string };
    const status = err?.response?.status;
    const body = err?.response?.data;
    if (__DEV__) {
      const bodyStr =
        typeof body === 'string'
          ? body.slice(0, 160)
          : body
            ? JSON.stringify(body).slice(0, 160)
            : err?.message ?? '<no body>';
      console.log('  →', status ?? 'NO_RESPONSE', 'error:', bodyStr);
    }
    return null;
  }
}

async function bruteForceMatch(
  tokens: StoredTokens,
  candidates: { source: string; value: string }[],
): Promise<BqeEmployee | null> {
  if (__DEV__) {
    console.log('[jot:employee] All targeted lookups failed — paginating all employees');
  }
  const all = await fetchAllPages<BqeEmployee>('/employee', {}, {
    baseURL: tokens.endpoint,
    headers: authHeaders(tokens),
  });
  if (__DEV__) console.log('[jot:employee] paginated', all.length, 'total employees');

  if (__DEV__) {
    const targets = candidates.map((c) => `${c.source}=${c.value}`).join(' | ');
    console.log('[jot:employee] searching for UUID match against:', targets);
  }

  for (let i = 0; i < all.length; i += 1) {
    const row = all[i] as AnyRow;
    const uuidFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && UUID_RE.test(v)) {
        uuidFields[k] = v;
      }
    }
    if (__DEV__) {
      console.log(`  [${i}]`, {
        id: row.id,
        first: pickStr(row, FIRST_NAME_KEYS),
        last: pickStr(row, LAST_NAME_KEYS),
        display: pickStr(row, DISPLAY_NAME_KEYS),
        email: pickStr(row, EMAIL_KEYS),
        uuids: uuidFields,
      });
    }
    for (const { source, value } of candidates) {
      for (const [field, fieldValue] of Object.entries(uuidFields)) {
        if (fieldValue === value) {
          if (__DEV__) {
            console.log(
              '[jot:employee] FOUND brute-force match: employee.' +
                field +
                ' === ' +
                source +
                ' (' +
                value +
                ')',
            );
          }
          return all[i];
        }
      }
    }
  }

  return null;
}

export async function fetchCurrentEmployee(tokens: StoredTokens): Promise<BqeEmployee> {
  const sub = tokens.idToken ? decodeIdTokenSub(tokens.idToken) : null;
  let userInfo: Record<string, unknown> | null = null;
  try {
    userInfo = await fetchUserInfo(tokens.accessToken);
  } catch (e) {
    if (__DEV__) console.log('[jot:employee] userinfo fetch failed:', e);
  }

  const userId = stringFrom(userInfo?.user_id) ?? stringFrom(userInfo?.userId);

  if (__DEV__) {
    console.log('[jot:employee] tokens.endpoint =', tokens.endpoint);
    console.log('[jot:employee] userinfo.user_id =', userId);
    console.log('[jot:employee] id_token sub    =', sub);
  }

  const baseURL = tokens.endpoint;
  const headers = authHeaders(tokens);

  // Targeted lookups in order. First one that returns a row wins.
  // BQE support said userinfo.user_id is the link to /employee but didn't
  // specify the field name — try the most likely options.
  const attempts: Array<{ desc: string; run: () => Promise<AxiosResponse> }> = [];

  if (userId) {
    attempts.push({
      desc: `GET /employee/${userId} (path with user_id)`,
      run: () => bqeClient.get(`/employee/${userId}`, { baseURL, headers }),
    });
  }
  if (sub && sub !== userId) {
    attempts.push({
      desc: `GET /employee/${sub} (path with sub)`,
      run: () => bqeClient.get(`/employee/${sub}`, { baseURL, headers }),
    });
  }
  if (userId) {
    attempts.push({
      desc: `where id='${userId}'`,
      run: () =>
        bqeClient.get('/employee', { baseURL, headers, params: { where: `id='${userId}'` } }),
    });
    attempts.push({
      desc: `where Id='${userId}' (PascalCase)`,
      run: () =>
        bqeClient.get('/employee', { baseURL, headers, params: { where: `Id='${userId}'` } }),
    });
    attempts.push({
      desc: `where userInfoId='${userId}'`,
      run: () =>
        bqeClient.get('/employee', {
          baseURL,
          headers,
          params: { where: `userInfoId='${userId}'` },
        }),
    });
    attempts.push({
      desc: `where token='${userId}'`,
      run: () =>
        bqeClient.get('/employee', { baseURL, headers, params: { where: `token='${userId}'` } }),
    });
  }

  for (const a of attempts) {
    const found = await tryLookup(a.desc, a.run);
    if (found) {
      if (__DEV__) {
        console.log('[jot:employee] MATCHED via', a.desc, '→', {
          id: (found as AnyRow).id,
          email: pickStr(found as AnyRow, EMAIL_KEYS),
          displayName: pickStr(found as AnyRow, DISPLAY_NAME_KEYS),
        });
      }
      return found;
    }
  }

  // Last resort: paginate every employee and search for any UUID field whose
  // value matches our user_id or sub. This will conclusively reveal the
  // BQE-side field name so we can hard-code it next time.
  const candidates: { source: string; value: string }[] = [];
  if (userId) candidates.push({ source: 'userinfo.user_id', value: userId });
  if (sub && sub !== userId) candidates.push({ source: 'id_token.sub', value: sub });

  if (candidates.length > 0) {
    const brute = await bruteForceMatch(tokens, candidates);
    if (brute) return brute;
  }

  throw new Error(
    'Could not resolve current user in /employee. None of the targeted lookups matched and no employee row contains a UUID field equal to userinfo.user_id or id_token.sub. Contact BQE admin to confirm this user has an Employee record.',
  );
}

export async function fetchEmployees(): Promise<BqeEmployee[]> {
  // BQE rejects `email` and `userId` in the fields projection — neither
  // exists on the /employee resource. Sticking to fields confirmed valid by
  // the row-key dump in fetchCurrentEmployee's brute-force log.
  return fetchAllPages<BqeEmployee>('/employee', {
    fields: 'id,displayName,firstName,lastName,billRate,costRate,status',
  });
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
