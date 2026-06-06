#!/usr/bin/env node
//
// bqe-test/submit-workflow.mjs
//
// Exercises the Submit-Week workflow PUT path that the Jot app uses in
// services/bqe/timeentry.ts (submitEntriesToWorkflow, ~line 627). For a
// single existing time entry, this script:
//
//   1. GETs /timeentry/{id} to read the BQE-side version (concurrency token)
//      along with projectId/activityId/resourceId/date/billable so we can
//      reconstruct a valid PUT body.
//   2. PUTs /timeentry/{id} with that body plus actualHours from --hours
//      and workflow: [{ action: "Submit" }], matching the app's wire shape.
//
// The full parsed response body is logged on both calls so we can see
// what BQE actually stored (e.g. did actualHours change, did the workflow
// state advance, did concurrency reject the update with OutDatedModel).
//
// Usage:
//   node submit-workflow.mjs --id=<entryId> --hours=<number>

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const log = (...args) => console.log('[submit]', ...args);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const args = parseArgs(process.argv.slice(2));

const required = ['id', 'hours'];
const missing = required.filter((k) => args[k] == null || args[k] === '');
if (missing.length > 0) {
  console.error('[submit] missing required args:', missing.join(', '));
  console.error('[submit] usage: node submit-workflow.mjs --id=<entryId> --hours=<number>');
  process.exit(1);
}

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[submit] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}
if (!token.access_token) {
  console.error('[submit] .token.json is missing access_token. Re-run auth.mjs.');
  process.exit(1);
}

// Prefer the tenant endpoint that BQE returned with the token (matches
// production Jot app behavior); fall back to BQE_API_BASE from .env.
const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!apiBase) {
  console.error('[submit] No tenant endpoint in .token.json and no BQE_API_BASE in .env');
  process.exit(1);
}

// Negated to match BQE's convention (and how the Jot app's bqeClient sets
// it). Server-side BQE uses this to localise the entry's wall-clock date.
const utcOffset = String(-new Date().getTimezoneOffset());
const entryUrl = `${apiBase}/timeentry/${args.id}`;

// -------------------------------------------------------------------------
// STEP 1 — GET the entry to capture version + required fields for the PUT.
// -------------------------------------------------------------------------

log('=== GET (read version) ===');
log('GET   =', entryUrl);
log('token =', token.access_token.slice(0, 16) + '… (length ' + token.access_token.length + ')');
log('X-UTC-OFFSET =', utcOffset);

const getResp = await fetch(entryUrl, {
  method: 'GET',
  headers: {
    authorization: `Bearer ${token.access_token}`,
    accept: 'application/json',
    'x-utc-offset': utcOffset,
  },
});

log('status =', getResp.status, getResp.statusText);

const getText = await getResp.text();
log('body length =', getText.length);

let getParsed = null;
try {
  getParsed = getText.length > 0 ? JSON.parse(getText) : null;
} catch {
  // not JSON — fall through
}

if (getParsed !== null) {
  log('body (parsed) =');
  console.log(JSON.stringify(getParsed, null, 2));
} else {
  log('body (raw) =');
  console.log(getText.slice(0, 4000));
  if (getText.length > 4000) {
    log(`(truncated — full body was ${getText.length} chars)`);
  }
}

if (getResp.status === 401) {
  console.log('');
  log('Token expired — run auth.mjs first.');
  process.exit(2);
}

if (!getResp.ok) {
  console.log('');
  log('Initial GET failed — aborting before PUT. Inspect the envelope above.');
  process.exit(1);
}

// BQE entry envelopes occasionally come wrapped (e.g. { data: {...} }) or
// arrive as a single-element array. Normalise to the record we need.
const entry = Array.isArray(getParsed)
  ? getParsed[0]
  : getParsed && typeof getParsed === 'object' && 'data' in getParsed && getParsed.data
    ? getParsed.data
    : getParsed;

if (!entry || typeof entry !== 'object') {
  log('Could not locate entry record in GET response — aborting.');
  process.exit(1);
}

const { projectId, activityId, resourceId, date, billable, version } = entry;

if (version == null) {
  log('Entry has no `version` field — cannot submit (BQE concurrency token required).');
  process.exit(1);
}

// -------------------------------------------------------------------------
// STEP 2 — Build PUT body. Mirror services/bqe/timeentry.ts submitEntries-
// ToWorkflow exactly: re-use the GET'd identifiers + version, override only
// actualHours from --hours, and tack on the workflow Submit action.
// -------------------------------------------------------------------------

const body = {
  projectId,
  activityId,
  resourceId,
  date,
  actualHours: Number(args.hours),
  billable,
  version,
  workflow: [{ action: 'Submit' }],
};

// -------------------------------------------------------------------------
// STEP 3 — PUT the entry with the workflow Submit action.
// -------------------------------------------------------------------------

console.log('');
log('=== PUT (workflow submit) ===');
log('PUT   =', entryUrl);
log('token =', token.access_token.slice(0, 16) + '… (length ' + token.access_token.length + ')');
log('X-UTC-OFFSET =', utcOffset);
log('body =');
console.log(JSON.stringify(body, null, 2));

const putResp = await fetch(entryUrl, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${token.access_token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'x-utc-offset': utcOffset,
  },
  body: JSON.stringify(body),
});

log('status =', putResp.status, putResp.statusText);

const putText = await putResp.text();
log('body length =', putText.length);

let putParsed = null;
try {
  putParsed = putText.length > 0 ? JSON.parse(putText) : null;
} catch {
  // not JSON — fall through
}

if (putParsed !== null) {
  log('body (parsed) =');
  console.log(JSON.stringify(putParsed, null, 2));
} else {
  log('body (raw) =');
  console.log(putText.slice(0, 4000));
  if (putText.length > 4000) {
    log(`(truncated — full body was ${putText.length} chars)`);
  }
}

if (putResp.status === 401) {
  console.log('');
  log('Token expired — run auth.mjs first.');
  process.exit(2);
}

if (!putResp.ok) {
  console.log('');
  log('PUT failed. Inspect the envelope above for BQE\'s error details.');
  log('Common causes:');
  log('  - OutDatedModel: version was stale; re-GET and retry.');
  log('  - ProjectControlLimitation: activityId not allowed for project.');
  log('  - Workflow state forbids Submit (entry already submitted/approved).');
  process.exit(1);
}

log('OK — entry submitted. Compare actualHours in the parsed body above.');

// -------------------------------------------------------------------------
// CLI parsing
// -------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) {
      out[a.slice(2)] = 'true';
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}
