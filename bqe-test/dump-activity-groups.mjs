#!/usr/bin/env node
//
// bqe-test/dump-activity-groups.mjs
//
// One-off diagnostic: produce bqe-test/output/activity-groups-dump.md
// containing every activity group in Studio G's BQE tenant and the
// activities each contains, sorted by approximate project usage.
//
// Plan:
//   1. GET /activity (paginated)     → name / code / billable / active per id
//   2. GET /group?where=type=139     → every activity-group row
//   3. GET /group/detail per group   → member activity IDs
//   4. GET /project (paginated)      → list of active parent projects
//   5. GET /project/{id}/activities  → count projects per group (concurrency 5)
//   6. Write markdown
//
// Step 5 is the long one — 3000+ projects @ ~150ms each = ~90s with batch 5.
// One-off cost; the resulting file is the deliverable.
//
// Endpoints used are the documented public REST API (not /webapp/Json/…).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'activity-groups-dump.md');

const log = (...args) => console.log('[dump]', ...args);

// -------------------------------------------------------------------------
// Token + base URL
// -------------------------------------------------------------------------

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[dump] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}
const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!token.access_token || !apiBase) {
  console.error('[dump] Token or endpoint missing — re-run auth.mjs.');
  process.exit(1);
}

const utcOffset = String(-new Date().getTimezoneOffset());
const headers = {
  authorization: `Bearer ${token.access_token}`,
  accept: 'application/json',
  'x-utc-offset': utcOffset,
};

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function getJson(url) {
  const resp = await fetch(url, { method: 'GET', headers });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${resp.status} ${url} — ${text.slice(0, 200)}`);
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.value)) return data.value;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.items)) return data.items;
  }
  return [];
}

async function getAllPages(path, params = {}, pageSize = 1000) {
  const out = [];
  let pageNum = 1;
  while (pageNum <= 200) {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) search.set(k, v);
    search.set('page', `${pageNum},${pageSize}`);
    const url = `${apiBase}${path}?${search.toString()}`;
    let data;
    try {
      data = await getJson(url);
    } catch (e) {
      // 204 surfaces as a fetch error too; treat as end-of-pages by checking
      // for explicit "204" in the message.
      if (String(e.message).startsWith('204 ')) break;
      throw e;
    }
    const rows = extractRows(data);
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    pageNum += 1;
  }
  return out;
}

async function boundedParallel(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx).catch((e) => ({ __error: e }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function yesno(b) {
  return b === true ? 'yes' : b === false ? 'no' : '?';
}

function escapeCell(s) {
  // Markdown table cell escapes — pipe and newline.
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// -------------------------------------------------------------------------
// 1. Activities
// -------------------------------------------------------------------------

log('1/5 fetching /activity …');
const activityRows = await getAllPages('/activity');
log(`     got ${activityRows.length} activity rows`);

// activityId -> { name, code, billable, active }
const activityById = new Map();
for (const row of activityRows) {
  const id = pickString(row, ['id']);
  if (!id) continue;
  activityById.set(id, {
    name: pickString(row, ['name', 'displayName']) ?? '(no name)',
    code: pickString(row, ['code']),
    // BQE's /activity rows have `billable: boolean` directly.
    billable: typeof row.billable === 'boolean' ? row.billable : null,
    active:
      typeof row.isActive === 'boolean'
        ? row.isActive
        : typeof row.active === 'boolean'
          ? row.active
          : null,
  });
}

// -------------------------------------------------------------------------
// 2. Activity groups (type 139)
// -------------------------------------------------------------------------

log('2/5 fetching /group?where=type=139 …');
let groupRows;
try {
  groupRows = await getAllPages('/group', { where: 'type=139' });
} catch (e) {
  log('     /group filter failed, falling back to unfiltered + client-side filter');
  log('     err:', e.message);
  const allGroups = await getAllPages('/group');
  groupRows = allGroups.filter((g) => g.type === 139 || g.type === '139');
}
log(`     got ${groupRows.length} activity-group rows`);

// id -> { name, isActive, ... }
const groupById = new Map();
for (const row of groupRows) {
  const id = pickString(row, ['id']);
  if (!id) continue;
  groupById.set(id, {
    name: pickString(row, ['name']) ?? '(no name)',
    description: pickString(row, ['description']),
    isActive: typeof row.isActive === 'boolean' ? row.isActive : null,
    isSystem: typeof row.isSystem === 'boolean' ? row.isSystem : null,
  });
}

// -------------------------------------------------------------------------
// 3. Group members via /group/detail
// -------------------------------------------------------------------------

log(`3/5 fetching /group/detail for ${groupById.size} groups (batches of 50)…`);
// /group/detail accepts a `groupId='X' OR groupId='Y' OR …` filter, so we
// can do many groups per request. Batch of 50 keeps URLs comfortable.
const groupIds = Array.from(groupById.keys());
const BATCH = 50;
const memberRows = [];
for (let i = 0; i < groupIds.length; i += BATCH) {
  const batch = groupIds.slice(i, i + BATCH);
  const where = batch.map((id) => `groupId='${id}'`).join(' OR ');
  try {
    const rows = await getAllPages('/group/detail', { where }, 1000);
    memberRows.push(...rows);
  } catch (e) {
    log(`     batch ${i / BATCH} FAILED:`, e.message);
  }
}
log(`     collected ${memberRows.length} group-detail rows total`);

// groupId -> Set<activityId>
const membersByGroup = new Map();
for (const row of memberRows) {
  const groupId = pickString(row, ['groupId']);
  const entityId = pickString(row, ['entityId']);
  if (!groupId || !entityId) continue;
  let set = membersByGroup.get(groupId);
  if (!set) {
    set = new Set();
    membersByGroup.set(groupId, set);
  }
  set.add(entityId);
}

// -------------------------------------------------------------------------
// 4. Active parent projects
// -------------------------------------------------------------------------

log('4/5 fetching /project (active parents) …');
// BQE: status=0 means Active. parentId is null/absent on parents.
const projectRows = await getAllPages('/project', {
  where: 'status=0',
  fields: 'id,name,parentId,parent,status',
});
log(`     got ${projectRows.length} active project rows (all levels)`);

const parentProjectIds = [];
for (const p of projectRows) {
  const id = pickString(p, ['id']);
  if (!id) continue;
  const hasParent =
    pickString(p, ['parentId']) !== null ||
    (p.parent && typeof p.parent === 'object' && pickString(p.parent, ['id']));
  if (!hasParent) parentProjectIds.push(id);
}
log(`     ${parentProjectIds.length} are top-level parents`);

// -------------------------------------------------------------------------
// 5. Per-project /project/{id}/activities — count usage per group
// -------------------------------------------------------------------------

log(`5/5 fetching /project/{id}/activities for ${parentProjectIds.length} parents (concurrency 5)…`);
const usageByGroup = new Map();
let progress = 0;
let unknownGroupCount = 0;

await boundedParallel(parentProjectIds, 5, async (projectId) => {
  let rows;
  try {
    const data = await getJson(`${apiBase}/project/${encodeURIComponent(projectId)}/activities`);
    rows = extractRows(data);
  } catch (e) {
    // Some projects (rarely) return 4xx on this endpoint; log and skip
    // rather than abort the whole dump.
    if (progress < 5) log(`     project ${projectId} ERR: ${e.message}`);
    rows = [];
  }
  for (const r of rows) {
    const gid = pickString(r, ['itemId', 'groupId']);
    if (!gid) continue;
    if (!groupById.has(gid)) unknownGroupCount += 1;
    usageByGroup.set(gid, (usageByGroup.get(gid) ?? 0) + 1);
  }
  progress += 1;
  if (progress % 250 === 0 || progress === parentProjectIds.length) {
    log(`     project-activity fetches: ${progress} / ${parentProjectIds.length}`);
  }
});
if (unknownGroupCount > 0) {
  log(
    `     note: ${unknownGroupCount} project-activity rows referenced a groupId not in /group (likely non-type-139)`,
  );
}

// -------------------------------------------------------------------------
// 6. Render markdown
// -------------------------------------------------------------------------

log('6/6 rendering markdown…');

// Sort groups by project-usage descending, ties broken by name.
const sortedGroups = Array.from(groupById.entries()).sort((a, b) => {
  const ua = usageByGroup.get(a[0]) ?? 0;
  const ub = usageByGroup.get(b[0]) ?? 0;
  if (ua !== ub) return ub - ua;
  return a[1].name.localeCompare(b[1].name);
});

// Unique activities across all groups (union).
const allActivityIds = new Set();
for (const set of membersByGroup.values()) {
  for (const id of set) allActivityIds.add(id);
}

const generatedAt = new Date().toISOString();
const lines = [];
lines.push('# Activity Groups Dump');
lines.push(`Generated: ${generatedAt}`);
lines.push(`Total groups: ${sortedGroups.length}`);
lines.push(`Total unique activities across all groups: ${allActivityIds.size}`);
lines.push('');

for (const [gid, g] of sortedGroups) {
  const memberIds = Array.from(membersByGroup.get(gid) ?? []);
  const usage = usageByGroup.get(gid) ?? 0;
  lines.push(`## ${g.name}`);
  lines.push(`- Group ID: \`${gid}\``);
  const statusBits = [];
  if (g.isActive === false) statusBits.push('inactive');
  if (g.isSystem === true) statusBits.push('system');
  if (g.description) statusBits.push(`description: ${g.description}`);
  if (statusBits.length > 0) lines.push(`- ${statusBits.join(' · ')}`);
  lines.push(`- Used by approximately ${usage} projects`);
  lines.push(`- Activities (${memberIds.length}):`);
  if (memberIds.length === 0) {
    lines.push('  _(none — empty group)_');
  } else {
    // Sort activity rows by name for readability.
    const rows = memberIds.map((aid) => {
      const a = activityById.get(aid);
      return {
        id: aid,
        name: a?.name ?? '(unknown — not in /activity)',
        code: a?.code ?? '',
        billable: a?.billable ?? null,
        active: a?.active ?? null,
      };
    });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    lines.push('');
    lines.push('  | Activity Name | Activity ID | Code | Billable | Active |');
    lines.push('  |---|---|---|---|---|');
    for (const r of rows) {
      lines.push(
        `  | ${escapeCell(r.name)} | \`${r.id}\` | ${escapeCell(r.code)} | ${yesno(r.billable)} | ${yesno(r.active)} |`,
      );
    }
  }
  lines.push('');
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.writeFile(OUTPUT_FILE, lines.join('\n'), 'utf8');

// -------------------------------------------------------------------------
// Summary to stdout
// -------------------------------------------------------------------------

const activeCount = Array.from(groupById.values()).filter((g) => g.isActive !== false).length;
const inactiveCount = groupById.size - activeCount;
const top5 = sortedGroups.slice(0, 5);

log('');
log('=== SUMMARY ===');
log(`groups total            : ${sortedGroups.length}`);
log(`  active                : ${activeCount}`);
log(`  inactive              : ${inactiveCount}`);
log(`unique activities       : ${allActivityIds.size}`);
log(`parent projects scanned : ${parentProjectIds.length}`);
log('');
log('TOP 5 groups by project usage:');
for (const [gid, g] of top5) {
  const usage = usageByGroup.get(gid) ?? 0;
  const memberCount = (membersByGroup.get(gid) ?? new Set()).size;
  log(`  ${usage} projects · ${memberCount} activities · ${g.name}`);
}
log('');
log('wrote', OUTPUT_FILE);
