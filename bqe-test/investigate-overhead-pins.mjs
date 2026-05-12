#!/usr/bin/env node
//
// bqe-test/investigate-overhead-pins.mjs
//
// One-off diagnostic for why PTO (0000.01) and Holiday (0000.02) reject
// activity-pinning POSTs while Office (0000.00) and Marketing (0000.03)
// accept theirs. All four use pins from what should be the Overhead
// activity group.
//
// Steps:
//   1. Look up each overhead project's record (confirm ids + parentId).
//   2. GET /project/<id>/activities for each to see which group(s) bind it.
//   3. For any unique groupId surfaced, GET /group/detail to see members.
//   4. Probe POSTs: PTO + OP-PTO (expected fail) vs Office + OA-Admin (success).
//      Captures full error envelopes so we can see BQE's reason.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const PROJECTS = [
  { code: '0000.00', id: '09b1c392-6451-4216-bb36-7ad0f9af9479', label: 'Office' },
  { code: '0000.01', id: 'eb2cdb74-4dbe-4876-808f-f542ae8599b1', label: 'PTO' },
  { code: '0000.02', id: 'c0ef8feb-c84d-445d-b780-2d4b3a3c311d', label: 'Holiday' },
  { code: '0000.03', id: 'a0d8c928-df47-47a3-8d7e-5a4e6bf09cff', label: 'Marketing' },
];

// Activity ids from the Studio G seed.
const ACTIVITY_OP_PTO       = 'ab4a5391-1010-4870-ab96-8f95814ceec3';
const ACTIVITY_OA_ADMIN_MISC = '915d7070-24b7-4307-9a2d-a52fc8d8710c';

// Hadyn's BQE resource id (from the prior session's POST test).
const RESOURCE_ID = '0da01f5a-a853-485a-93f8-65a4a8f7e67a';

// -------------------------------------------------------------------------

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[investigate] No .token.json — run auth.mjs/refresh.mjs first.');
  process.exit(1);
}
const apiBase = (token.endpoint ?? '').replace(/\/+$/, '');
if (!token.access_token || !apiBase) {
  console.error('[investigate] missing token/endpoint');
  process.exit(1);
}
const headers = {
  authorization: `Bearer ${token.access_token}`,
  accept: 'application/json',
  'x-utc-offset': String(-new Date().getTimezoneOffset()),
};

function indent(s, p = '    ') {
  return s.split('\n').map((l) => p + l).join('\n');
}
function section(title) {
  console.log('');
  console.log('==========================================================');
  console.log(`  ${title}`);
  console.log('==========================================================');
}

async function fetchRaw(method, urlOrPath, body) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${apiBase}${urlOrPath}`;
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let parsed = null;
  try {
    if (text.length > 0) parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { url, status: resp.status, statusText: resp.statusText, body: text, parsed };
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

// -------------------------------------------------------------------------
// 1. Project records
// -------------------------------------------------------------------------

section('1. Project records — /project?where=id=…&fields=id,name,code,parentId');

const projectRecords = [];
for (const p of PROJECTS) {
  const where = encodeURIComponent(`id='${p.id}'`);
  const url = `/project?where=${where}&fields=id,name,code,parentId,status,contractType`;
  console.log(`  GET ${apiBase}${url}`);
  const r = await fetchRaw('GET', url);
  console.log(`       status = ${r.status} ${r.statusText ?? ''}`);
  const rows = extractRows(r.parsed);
  const row = rows[0] ?? null;
  if (!row) {
    console.log('       NO ROWS');
  } else {
    console.log('       row =');
    console.log(indent(JSON.stringify(row, null, 2)));
  }
  projectRecords.push({ ...p, row });
  console.log('');
}

// -------------------------------------------------------------------------
// 2. /project/{id}/activities for each
// -------------------------------------------------------------------------

section('2. /project/{id}/activities — which activity-group(s) bind each project');

const groupsByProject = new Map(); // projectId -> [{ itemId, item, itemType }, ...]
for (const p of projectRecords) {
  console.log(`  ${p.label}  (${p.code} · ${p.id})`);
  const r = await fetchRaw('GET', `/project/${encodeURIComponent(p.id)}/activities`);
  console.log(`       status = ${r.status}`);
  const rows = extractRows(r.parsed);
  if (rows.length === 0) {
    console.log('       NO BOUND GROUPS (empty array)');
    groupsByProject.set(p.id, []);
  } else {
    for (const row of rows) {
      console.log(
        '       •',
        JSON.stringify({
          id: row.id,
          itemId: row.itemId,
          item: row.item,
          itemType: row.itemType,
          billable: row.billable,
          description: row.description,
        }),
      );
    }
    groupsByProject.set(
      p.id,
      rows.map((r) => ({
        itemId: r.itemId,
        item: r.item,
        itemType: r.itemType,
        billable: r.billable,
      })),
    );
  }
  console.log('');
}

// -------------------------------------------------------------------------
// 3. /group/detail for every unique groupId discovered
// -------------------------------------------------------------------------

section("3. /group/detail for every unique groupId surfaced — what's in each?");

const uniqueGroupIds = new Set();
for (const bindings of groupsByProject.values()) {
  for (const b of bindings) if (b.itemId) uniqueGroupIds.add(b.itemId);
}
console.log(`  unique groupIds across the 4 projects = ${uniqueGroupIds.size}`);
console.log('');

const groupActivities = new Map(); // groupId -> [{ entityId, entity }, ...]
for (const gid of uniqueGroupIds) {
  // Try to fetch the group's own record for context (name) plus its members.
  const groupRecord = await fetchRaw('GET', `/group/${encodeURIComponent(gid)}`);
  const groupName =
    groupRecord.parsed?.name ??
    groupRecord.parsed?.displayName ??
    '(no name)';
  console.log(`  ${gid}  →  "${groupName}"`);

  const detail = await fetchRaw(
    'GET',
    `/group/detail?where=${encodeURIComponent(`groupId='${gid}'`)}&page=1,1000`,
  );
  const rows = extractRows(detail.parsed);
  groupActivities.set(
    gid,
    rows.map((r) => ({ entityId: r.entityId, entity: r.entity })),
  );
  console.log(`       members (${rows.length}):`);
  for (const row of rows) {
    console.log(`         · ${row.entity}  (${row.entityId})`);
  }
  console.log('');
}

// Quick membership check for the four pinned activities.
function memberOfAny(activityId) {
  const out = [];
  for (const [gid, list] of groupActivities.entries()) {
    if (list.some((m) => m.entityId === activityId)) out.push(gid);
  }
  return out;
}

console.log('  Pin → group membership check:');
const pinChecks = [
  { label: 'OA- Administration Misc. (Office pin)', id: ACTIVITY_OA_ADMIN_MISC },
  { label: 'OP- PTO (PTO pin)', id: ACTIVITY_OP_PTO },
];
for (const c of pinChecks) {
  const groups = memberOfAny(c.id);
  console.log(
    `    ${c.label}  → present in ${groups.length} of the 4 projects' groups: ${groups.join(', ') || 'NONE'}`,
  );
}

// -------------------------------------------------------------------------
// 4. POST probes — PTO + OP-PTO (expected fail) vs Office + OA-Admin (success)
// -------------------------------------------------------------------------

section('4. POST probes — actual server response');

const today = new Date();
const isoDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}T00:00:00`;

async function probePost(label, projectId, activityId) {
  console.log(`  [${label}]`);
  console.log(`    projectId  = ${projectId}`);
  console.log(`    activityId = ${activityId}`);
  console.log(`    date       = ${isoDate}`);
  const body = {
    projectId,
    activityId,
    resourceId: RESOURCE_ID,
    date: isoDate,
    actualHours: 0.01,
    billable: false,
    description: 'BQE diag — investigate-overhead-pins probe — DELETE ME',
    memo: 'BQE diag — investigate-overhead-pins probe — DELETE ME',
  };
  const r = await fetchRaw('POST', '/timeentry', body);
  console.log(`    status     = ${r.status} ${r.statusText ?? ''}`);
  if (r.parsed !== null) {
    console.log('    body (parsed) =');
    console.log(indent(JSON.stringify(r.parsed, null, 2), '      '));
  } else {
    console.log('    body (raw) =');
    console.log(indent(r.body, '      '));
  }
  console.log('');
  return r;
}

const ptoProbe = await probePost(
  'PTO + OP-PTO (expected failure)',
  PROJECTS[1].id,
  ACTIVITY_OP_PTO,
);
const officeProbe = await probePost(
  'Office + OA-Administration Misc. (expected success)',
  PROJECTS[0].id,
  ACTIVITY_OA_ADMIN_MISC,
);

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------

section('SUMMARY');
console.log('Project bindings:');
for (const p of projectRecords) {
  const bindings = groupsByProject.get(p.id) ?? [];
  console.log(
    `  ${p.code}  ${p.label.padEnd(10)}  groups = ${bindings.map((b) => `${b.itemId} (${b.item}, type=${b.itemType})`).join('; ') || '(none)'}`,
  );
}
console.log('');
console.log(`POST PTO+OP-PTO        : ${ptoProbe.status} ${ptoProbe.statusText ?? ''}`);
console.log(`POST Office+OA-AdminMisc: ${officeProbe.status} ${officeProbe.statusText ?? ''}`);
