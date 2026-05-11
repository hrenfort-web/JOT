#!/usr/bin/env node
//
// bqe-test/discover.mjs
//
// One-off discovery script. Probes several candidate BQE endpoints to find
// out HOW the BQE web UI knows the correct activityId for a given project
// (since /projectassignment returned 0 rows for Studio G). Three sequenced
// investigations, dumping raw responses for analysis.
//
// Run after `node auth.mjs` has populated .token.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

// The Office overhead project Hadyn just successfully POSTed an entry to.
// Hardcoded because this script is a one-off investigation tied to that
// specific failure case.
const PROJECT_ID = '09b1c392-6451-4216-bb36-7ad0f9af9479';

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[discover] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}
if (!token.access_token) {
  console.error('[discover] .token.json is missing access_token. Re-run auth.mjs.');
  process.exit(1);
}

const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!apiBase) {
  console.error('[discover] No tenant endpoint in .token.json and no BQE_API_BASE in .env');
  process.exit(1);
}

const utcOffset = String(-new Date().getTimezoneOffset());

const baseHeaders = {
  authorization: `Bearer ${token.access_token}`,
  accept: 'application/json',
  'x-utc-offset': utcOffset,
};

// -------------------------------------------------------------------------
// Helper: issue a request and dump the response in a uniform format.
// Returns { status, body, parsed } so callers can do extra processing.
// -------------------------------------------------------------------------

async function tryRequest(method, urlOrPath, body) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${apiBase}${urlOrPath}`;
  const opts = { method, headers: { ...baseHeaders } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    console.log(`  ${method.padEnd(4)} ${url}`);
    console.log(`       NETWORK ERROR: ${e.message}`);
    return { status: 0, body: '', parsed: null };
  }
  const text = await resp.text();
  let parsed = null;
  try {
    if (text.length > 0) parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: resp.status, statusText: resp.statusText, body: text, parsed };
}

function summarize(result, opts = {}) {
  const { status, statusText, body, parsed } = result;
  const max = opts.maxChars ?? 1200;
  console.log(`       status = ${status} ${statusText ?? ''}`);
  if (status === 0) return;
  if (body.length === 0) {
    console.log('       (empty body)');
    return;
  }
  if (parsed !== null) {
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty.length <= max) {
      console.log('       body =');
      console.log(indent(pretty, '         '));
    } else {
      console.log(`       body (truncated to ${max} chars of ${pretty.length}) =`);
      console.log(indent(pretty.slice(0, max) + '…', '         '));
    }
  } else {
    console.log('       body (raw, not JSON) =');
    console.log(indent(body.slice(0, max), '         '));
    if (body.length > max) console.log(`       … (truncated; ${body.length} chars total)`);
  }
}

function indent(s, prefix) {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function sectionHeader(text) {
  console.log('');
  console.log('==========================================================');
  console.log(text);
  console.log('==========================================================');
}

// -------------------------------------------------------------------------
// INVESTIGATION 1 — Project record
// Does the /project/{id} response itself contain an activity hint?
// -------------------------------------------------------------------------

sectionHeader('INVESTIGATION 1 — GET /project/{id} (looking for activity fields)');

{
  const result = await tryRequest('GET', `/project/${PROJECT_ID}`);
  console.log(`  GET ${apiBase}/project/${PROJECT_ID}`);
  console.log(`       status = ${result.status} ${result.statusText ?? ''}`);
  if (result.parsed !== null) {
    console.log('       full body =');
    console.log(indent(JSON.stringify(result.parsed, null, 2), '         '));

    // Surface any field whose name hints at activity / control / rule.
    const matchers = /activity|defaultactivity|activitygroup|controlgroup|rule|stc|timeentry/i;
    const obj = result.parsed;
    console.log('');
    console.log('  Fields matching /activity|defaultActivity|activityGroup|controlGroup|rule|stc|timeentry/i :');
    let found = 0;
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (matchers.test(k)) {
          let preview;
          if (v == null) preview = String(v);
          else if (typeof v === 'object') preview = JSON.stringify(v).slice(0, 200);
          else preview = String(v).slice(0, 200);
          console.log(`    - ${k}: ${preview}`);
          found += 1;
        }
      }
    }
    if (found === 0) {
      console.log('    (none)');
    }
  } else {
    console.log('       body (raw) =');
    console.log(indent(result.body.slice(0, 4000), '         '));
  }
}

// -------------------------------------------------------------------------
// INVESTIGATION 2 — candidate sub-endpoints and *assignment tables
// -------------------------------------------------------------------------

sectionHeader('INVESTIGATION 2 — candidate project-scoped endpoints');

const candidates = [
  { method: 'GET', path: `/project/${PROJECT_ID}/activity` },
  { method: 'GET', path: `/project/${PROJECT_ID}/activities` },
  { method: 'GET', path: `/project/${PROJECT_ID}/defaultactivity` },
  { method: 'GET', path: `/project/${PROJECT_ID}/timeentrydefaults` },
  { method: 'GET', path: `/project/${PROJECT_ID}/rules` },
  {
    method: 'GET',
    path: `/projectactivity?where=${encodeURIComponent(`projectId='${PROJECT_ID}'`)}`,
  },
  {
    method: 'GET',
    path: `/projectactivityassignment?where=${encodeURIComponent(`projectId='${PROJECT_ID}'`)}`,
  },
  {
    method: 'GET',
    path: `/timeentrydefault?where=${encodeURIComponent(`projectId='${PROJECT_ID}'`)}`,
  },
];

for (const c of candidates) {
  console.log('');
  console.log(`  ${c.method.padEnd(4)} ${apiBase}${c.path}`);
  const result = await tryRequest(c.method, c.path);

  if (result.status === 404) {
    console.log(`       status = 404 — not available`);
    continue;
  }
  if (result.status === 401 || result.status === 403) {
    console.log(`       status = ${result.status} — auth/permission issue`);
    if (result.body) {
      console.log(`       body = ${result.body.slice(0, 300)}`);
    }
    continue;
  }
  summarize(result);
}

// -------------------------------------------------------------------------
// INVESTIGATION 3 — The web UI's GetSTCDefaults endpoint
// 3 methods × 2 case variants = 6 calls
// -------------------------------------------------------------------------

sectionHeader('INVESTIGATION 3 — GetSTCDefaults (the web UI endpoint)');

const stcVariants = [
  // PascalCase resource
  { method: 'GET', path: '/TimeEntry/GetSTCDefaults' },
  {
    method: 'GET',
    path: `/TimeEntry/GetSTCDefaults?projectId=${PROJECT_ID}`,
  },
  {
    method: 'POST',
    path: '/TimeEntry/GetSTCDefaults',
    body: { projectId: PROJECT_ID },
  },
  // lowercase resource (BQE has historically aliased both casings on the
  // same controller; worth confirming explicitly)
  { method: 'GET', path: '/timeentry/GetSTCDefaults' },
  {
    method: 'GET',
    path: `/timeentry/GetSTCDefaults?projectId=${PROJECT_ID}`,
  },
  {
    method: 'POST',
    path: '/timeentry/GetSTCDefaults',
    body: { projectId: PROJECT_ID },
  },
];

for (const v of stcVariants) {
  console.log('');
  console.log(`  ${v.method.padEnd(4)} ${apiBase}${v.path}`);
  if (v.body) {
    console.log(`       request body = ${JSON.stringify(v.body)}`);
  }
  const result = await tryRequest(v.method, v.path, v.body);
  summarize(result);
}

console.log('');
console.log('=== discovery complete ===');
