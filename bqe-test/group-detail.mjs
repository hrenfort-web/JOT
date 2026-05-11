#!/usr/bin/env node
//
// bqe-test/group-detail.mjs
//
// Follow-up to discover.mjs. Project /activities returned a single row
// pointing at the "Overhead (OA,OM,OP) Activities Group" (itemId
// 51aec4af-99e9-496f-9972-101df837c690). This script confirms whether
// fetching the group's record (or its detail list) returns the member
// activityIds — and specifically whether the OA-Accounting activity
// (76f667db-9f1b-4f53-a225-a2d377182948) is a documented member.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const PROJECT_ID = '09b1c392-6451-4216-bb36-7ad0f9af9479';
const GROUP_ID = '51aec4af-99e9-496f-9972-101df837c690';
const TARGET_ACTIVITY_ID = '76f667db-9f1b-4f53-a225-a2d377182948';

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[group] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}
if (!token.access_token) {
  console.error('[group] .token.json is missing access_token. Re-run auth.mjs.');
  process.exit(1);
}

const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
const utcOffset = String(-new Date().getTimezoneOffset());

const baseHeaders = {
  authorization: `Bearer ${token.access_token}`,
  accept: 'application/json',
  'x-utc-offset': utcOffset,
};

// Tracks per-probe results so we can summarize "which endpoints surfaced the
// target activityId" at the bottom of the run.
const findings = [];

async function probe(label, method, urlOrPath) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${apiBase}${urlOrPath}`;
  console.log('');
  console.log('----------------------------------------------------------');
  console.log(`  [${label}]`);
  console.log(`  ${method.padEnd(4)} ${url}`);
  let resp;
  try {
    resp = await fetch(url, { method, headers: baseHeaders });
  } catch (e) {
    console.log(`       NETWORK ERROR: ${e.message}`);
    findings.push({ label, url, status: 0, found: false });
    return;
  }
  const text = await resp.text();
  const status = resp.status;
  const found = text.includes(TARGET_ACTIVITY_ID);
  findings.push({ label, url, status, found });

  console.log(`       status = ${status} ${resp.statusText ?? ''}`);

  if (!resp.ok) {
    if (text.length === 0) {
      console.log('       (empty body)');
    } else {
      console.log('       body =');
      console.log(indent(text.slice(0, 800), '         '));
      if (text.length > 800) console.log(`       … (truncated; ${text.length} chars total)`);
    }
    return;
  }

  // Pretty-print full body for 2xx. No truncation — the user explicitly
  // asked to see the full body of every 2xx response.
  try {
    const parsed = JSON.parse(text);
    console.log('       full body =');
    console.log(indent(JSON.stringify(parsed, null, 2), '         '));
  } catch {
    console.log('       body (raw, not JSON) =');
    console.log(indent(text, '         '));
  }

  console.log(
    `       contains target activityId (${TARGET_ACTIVITY_ID}) = ${found ? 'YES' : 'no'}`,
  );
}

function indent(s, prefix) {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

console.log('==========================================================');
console.log(' Group / activity-group probes');
console.log(`  projectId         = ${PROJECT_ID}`);
console.log(`  groupId           = ${GROUP_ID}`);
console.log(`  target activityId = ${TARGET_ACTIVITY_ID}  (OA-Accounting)`);
console.log('==========================================================');

// ------------------------------------------------------------------ 1
await probe(
  '1. group/{id}',
  'GET',
  `/group/${GROUP_ID}`,
);

// ------------------------------------------------------------------ 2
await probe(
  '2. group/detail filtered by groupId',
  'GET',
  `/group/detail?where=${encodeURIComponent(`groupId='${GROUP_ID}'`)}`,
);

// ------------------------------------------------------------------ 3
await probe(
  '3. group?where=id=... &expand=details',
  'GET',
  `/group?where=${encodeURIComponent(`id='${GROUP_ID}'`)}&expand=details`,
);

// ------------------------------------------------------------------ 4
await probe(
  '4. groupdetail (alternative single-word casing)',
  'GET',
  `/groupdetail?where=${encodeURIComponent(`groupId='${GROUP_ID}'`)}`,
);

// ------------------------------------------------------------------ 5
// Comparison: re-pull the project's /activities endpoint (full body) and
// try two related sub-paths that might short-circuit the group lookup.
await probe(
  '5a. project/{id}/activities (re-probe, full body)',
  'GET',
  `/project/${PROJECT_ID}/activities`,
);
await probe(
  '5b. project/{id}/activitiesdetail',
  'GET',
  `/project/${PROJECT_ID}/activitiesdetail`,
);
await probe(
  '5c. project/{id}/groupdetail',
  'GET',
  `/project/${PROJECT_ID}/groupdetail`,
);

// -------------------------------------------------------------------------
// Summary: which probes returned the target activityId?
// -------------------------------------------------------------------------

console.log('');
console.log('==========================================================');
console.log(' SUMMARY: which probes surfaced the target activityId?');
console.log('==========================================================');
const hits = findings.filter((f) => f.found);
const misses = findings.filter((f) => !f.found);

if (hits.length === 0) {
  console.log('  No probe returned the activityId. Either the membership is');
  console.log('  exposed under a different endpoint, or the group/detail');
  console.log('  endpoint requires a different filter syntax.');
} else {
  for (const h of hits) {
    console.log(`  ✓ ${h.label} — ${h.status} ${h.url}`);
  }
}

console.log('');
console.log('  Probes that did NOT contain the activityId:');
for (const m of misses) {
  console.log(`    · ${m.label} — status ${m.status}`);
}
console.log('');
console.log('=== group-detail probe complete ===');
