import { bqeClient, fetchAllPages } from './client';
import { fetchUserInfo, StoredTokens } from './auth';
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

/**
 * Resolve the current user's BQE identity for login.
 *
 * Identity comes from OIDC `GET /idp/connect/userinfo` — an endpoint EVERY
 * BQE user can read — NOT from the `/employee` roster list, which is
 * admin-gated and 403s for a standard (non-admin) timekeeper. Harness
 * testing confirmed `userinfo.user_id` === the employee `id` (the BQE
 * resourceId) exactly, so `user_id` is authoritative.
 *
 * Flow:
 *   1. userinfo → user_id (the resourceId). Absent user_id is the ONLY hard
 *      failure — without it we have no id to charge time against.
 *   2. Synthesize the full user object from userinfo claims (name/email).
 *      This alone is a complete, loggable identity.
 *   3. ONE optional enrichment: GET /employee/{user_id} (path-style self-
 *      read). ANY failure — 403 / 404 / 204 / network / id-less body — is
 *      caught and ignored; login proceeds on the synthesized identity. The
 *      roster list is never called.
 */
export async function fetchCurrentEmployee(tokens: StoredTokens): Promise<BqeEmployee> {
  let userInfo: Record<string, unknown> | null = null;
  try {
    userInfo = await fetchUserInfo(tokens.accessToken);
  } catch (e) {
    if (__DEV__) console.log('[jot:employee] userinfo fetch failed:', e);
  }

  // userinfo.user_id is the BQE resourceId (=== employee.id, verified live).
  const userId = stringFrom(userInfo?.user_id) ?? stringFrom(userInfo?.userId);
  if (!userId) {
    // The ONLY hard failure. No user_id → no resourceId → we cannot create
    // time entries. Distinct message so login surfaces the real cause
    // instead of a generic parse/network error.
    throw new Error(
      'BQE userinfo did not return user_id; cannot resolve identity. ' +
        'Confirm this user has BQE Core access, or contact your administrator.',
    );
  }

  // Synthesize a complete identity from userinfo claims — enough to log in
  // and charge time with no /employee call at all.
  const given = stringFrom(userInfo?.given_name);
  const family = stringFrom(userInfo?.family_name);
  const email = stringFrom(userInfo?.email);
  const nameClaim = stringFrom(userInfo?.name);
  const joined = [given, family].filter((s): s is string => !!s).join(' ');
  const synthesizedDisplayName =
    nameClaim ?? (joined.length > 0 ? joined : null) ?? email ?? undefined;

  const user: BqeEmployee = {
    id: userId,
    displayName: synthesizedDisplayName,
    firstName: given ?? undefined,
    lastName: family ?? undefined,
    email: email ?? undefined,
    userId,
  };

  if (__DEV__) {
    console.log('[jot:employee] resolved identity from userinfo — id =', userId);
  }

  // Optional enrichment: a single path-style self-read of the user's OWN
  // employee record. Standard users can read their own record; but if this
  // 403s / 404s / 204s / errors / returns no id we IGNORE it — the
  // synthesized user above is already valid and login must not block on it.
  // Explicit baseURL + headers because the axios interceptor reads tokens
  // from the auth store, which isn't populated until AFTER login() (this
  // runs before login()).
  try {
    const resp = await bqeClient.get(`/employee/${userId}`, {
      baseURL: tokens.endpoint,
      headers: authHeaders(tokens),
    });
    const row = resp?.data;
    const obj =
      row && typeof row === 'object' && !Array.isArray(row)
        ? (row as Record<string, unknown>)
        : null;
    if (obj && stringFrom(obj.id)) {
      const displayName = stringFrom(obj.displayName);
      const firstName = stringFrom(obj.firstName);
      const lastName = stringFrom(obj.lastName);
      const defaultGroupId = stringFrom(obj.defaultGroupId);
      const securityProfileId = stringFrom(obj.securityProfileId);
      if (displayName) user.displayName = displayName;
      if (firstName) user.firstName = firstName;
      if (lastName) user.lastName = lastName;
      // Attached via BqeEmployee's index signature — used by activity
      // resolution / future gating when present.
      if (defaultGroupId) user.defaultGroupId = defaultGroupId;
      if (securityProfileId) user.securityProfileId = securityProfileId;
      if (__DEV__) console.log('[jot:employee] enriched from GET /employee/{id}');
    }
  } catch (e) {
    if (__DEV__) {
      console.log(
        '[jot:employee] enrichment GET /employee/{id} failed (non-fatal, using userinfo identity):',
        e instanceof Error ? e.message : e,
      );
    }
  }

  return user;
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
    'saveEmployees',
  );
}

export async function fetchAndSaveEmployees(
  isStale?: () => boolean,
): Promise<number> {
  const employees = await fetchEmployees();
  if (isStale?.()) return 0;
  await saveEmployees(employees);
  return employees.length;
}

export async function loadEmployees(): Promise<LocalEmployee[]> {
  return getAll<LocalEmployeeRow>(
    'SELECT * FROM LocalEmployee ORDER BY displayName ASC',
  );
}
