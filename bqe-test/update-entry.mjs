#!/usr/bin/env node
//
// bqe-test/update-entry.mjs
//
// Verifies the SB-1 fix: the sync queue's UPDATE branch for a pending row
// that already carries a bqeId must PUT the existing BQE entry, NOT POST a
// duplicate. This script reproduces, at the HTTP level, the exact request
// that services/sync/queue.ts (update branch, row.bqeId != null) →
// services/bqe/timeentry.ts::updateEntry builds. A Node harness can't
// import the app's RN axios client (bqeClient) or expo-sqlite, so the
// request is reconstructed here with a BODY IDENTICAL to the queue's:
//   - date  → toBqeDate: "YYYY-MM-DD" + "T00:00:00"  (utils.ts:42-49)
//   - description → applySourceTag(memo, source)      (sourceTag.ts:60-72, inlined verbatim below)
//   - key set → projectId, activityId, resourceId, date, actualHours,
//               billable, description, memo, version  (timeentry.ts:411-420)
//
// Flow:
//   1. GET  /timeentry/{id}      — capture current version + identity fields
//   2. PUT  /timeentry/{id}      — queue-identical body with new hours/memo
//   3. GET  /timeentry/{id}      — confirm change landed on the SAME id, version advanced
//   4. GET  /timeentry?where=... — confirm exactly ONE entry on (resourceId, date)
//                                  carries the test marker (no duplicate POST)
//
// Usage:
//   node update-entry.mjs <entryId> --hours=0.75 --memo="new text" [--source=manual|scanned]
//
// MUTATES PRODUCTION DATA on the target entry. Use only on rows created by
// post-entry.mjs during diagnostics.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const log = (...args) => console.log('[update]', ...args);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

// ── applySourceTag — copied VERBATIM from utils/sourceTag.ts:24-72 so the
// `description` this harness sends is identical to the queue's. Keep in
// sync if the app-side tag logic changes.
const TAG_SCAN = '#js';
const TAG_MANUAL = '#jm';
const STRIP_TAG = /\s*#(js|jm)\b/g;
function tagFor(source) {
  switch (source) {
    case 'scanned':
      return TAG_SCAN;
    case 'manual':
      return TAG_MANUAL;
    default:
      return null;
  }
}
function applySourceTag(value, source) {
  const wantedTag = tagFor(source);
  if (wantedTag === null) return value ?? '';
  const input = value ?? '';
  const stripped = input.replace(STRIP_TAG, '').replace(/\s+/g, ' ').trim();
  if (stripped.length === 0) return wantedTag;
  return `${stripped} ${wantedTag}`;
}

// ── toBqeDate — matches utils/bqe/utils.ts:42-49 for a YYYY-MM-DD string.
function toBqeDate(ymd) {
  return `${ymd.slice(0, 10)}T00:00:00`;
}

const entryId = process.argv[2];
const flags = {};
for (const a of process.argv.slice(3)) {
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq === -1) flags[a.slice(2)] = 'true';
  else flags[a.slice(2, eq)] = a.slice(eq + 1);
}

if (!entryId || flags.hours == null) {
  console.error('[update] usage: node update-entry.mjs <entryId> --hours=0.75 --memo="..." [--source=manual|scanned]');
  process.exit(1);
}
const source = flags.source ?? 'manual';

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[update] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}
if (!token.access_token) {
  console.error('[update] .token.json is missing access_token. Re-run auth.mjs.');
  process.exit(1);
}

const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!apiBase) {
  console.error('[update] No tenant endpoint in .token.json and no BQE_API_BASE in .env');
  process.exit(1);
}

const utcOffset = String(-new Date().getTimezoneOffset());
const headers = {
  authorization: `Bearer ${token.access_token}`,
  accept: 'application/json',
  'x-utc-offset': utcOffset,
};

async function getJson(url) {
  const resp = await fetch(url, { method: 'GET', headers });
  const text = await resp.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  return { status: resp.status, body, text };
}

// ── Step 1: GET current state ────────────────────────────────────────────
const entryUrl = `${apiBase}/timeentry/${encodeURIComponent(entryId)}`;
log('STEP 1 — GET', entryUrl);
const before = await getJson(entryUrl);
log('status =', before.status);
if (before.status !== 200 || !before.body) {
  console.error('[update] could not fetch entry before update; body:', before.text.slice(0, 500));
  process.exit(1);
}
log('before: hours =', before.body.actualHours, '| memo =', JSON.stringify(before.body.memo), '| version =', before.body.version);

// ── Step 2: PUT — body IDENTICAL to queue.ts update branch → updateEntry ──
const newHours = Number(flags.hours);
const newMemo = flags.memo ?? before.body.memo ?? '';
const ymd = (before.body.date ?? '').slice(0, 10);
const putBody = {
  projectId: before.body.projectId,
  activityId: before.body.activityId,
  resourceId: before.body.resourceId,
  date: toBqeDate(ymd),
  actualHours: newHours,
  billable: before.body.billable ?? true,
  description: applySourceTag(newMemo, source),
  memo: newMemo,
  version: before.body.version,
};
log('STEP 2 — PUT', entryUrl);
log('body =', JSON.stringify(putBody, null, 2));
const putResp = await fetch(entryUrl, {
  method: 'PUT',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(putBody),
});
const putText = await putResp.text();
log('status =', putResp.status, putResp.statusText);
let putParsed = null;
try {
  putParsed = putText.length > 0 ? JSON.parse(putText) : null;
} catch {
  /* raw */
}
if (putParsed !== null) {
  log('response id =', putParsed.id, '| version =', putParsed.version, '| actualHours =', putParsed.actualHours);
} else {
  log('response (raw) =', putText.slice(0, 1000));
}
if (!putResp.ok) {
  console.error('[update] PUT FAILED — see body above (409 OutDatedModel = version conflict; 5xx GeneralException = often a deleted entry).');
  process.exit(3);
}

// ── Step 3: GET after — confirm the change landed on the SAME id ─────────
log('STEP 3 — GET (after)', entryUrl);
const after = await getJson(entryUrl);
log('status =', after.status);
if (after.status !== 200 || !after.body) {
  console.error('[update] could not re-fetch entry after update');
  process.exit(1);
}
log('after: hours =', after.body.actualHours, '| memo =', JSON.stringify(after.body.memo), '| description =', JSON.stringify(after.body.description), '| version =', after.body.version);

const hoursLanded = Number(after.body.actualHours) === newHours;
const sameId = after.body.id === before.body.id;
const versionAdvanced = String(after.body.version) !== String(before.body.version);
log(`verify: hours updated = ${hoursLanded} | same id = ${sameId} | version advanced = ${versionAdvanced}`);

// ── Step 4: duplicate check — count entries on (resourceId, date) with the
// test memo marker. Exactly 1 expected: the updated original, no new POST.
const whereClause = `resourceId='${before.body.resourceId}' AND date>='${ymd}' AND date<='${ymd}'`;
const listUrl = `${apiBase}/timeentry?where=${encodeURIComponent(whereClause)}`;
log('STEP 4 — duplicate check GET', listUrl);
const list = await getJson(listUrl);
log('status =', list.status);
const rows = Array.isArray(list.body) ? list.body : [];
const marker = newMemo.slice(0, 20);
const matches = rows.filter((r) => (r.memo ?? '').includes(marker));
log(`entries on ${ymd} for this resource = ${rows.length}; matching test marker "${marker}" = ${matches.length}`);
for (const m of matches) {
  log(`  match: id=${m.id} hours=${m.actualHours} memo=${JSON.stringify(m.memo)}`);
}

const noDuplicate = matches.length === 1 && matches[0].id === before.body.id;
log('');
if (hoursLanded && sameId && noDuplicate) {
  log('OK — update landed on the same entry, version advanced, no duplicate created.');
  process.exit(0);
} else {
  console.error('[update] VERIFICATION FAILED — see checks above.');
  process.exit(4);
}
