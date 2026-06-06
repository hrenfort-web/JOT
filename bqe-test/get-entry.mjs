#!/usr/bin/env node
//
// bqe-test/get-entry.mjs
//
// Single-entry counterpart to get-entries.mjs: fetches ONE time entry by id
// (GET /timeentry/{id}) and dumps the response. Useful for inspecting the
// exact shape BQE returns for a known-good (or known-bad) entry after a
// POST or sync test.
//
// Usage:
//   node get-entry.mjs <id>
//
// Read-only — does not mutate any BQE state.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const log = (...args) => console.log('[get-one]', ...args);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const id = process.argv[2];
if (!id) {
  console.error('[get-one] missing required positional arg: <id>');
  console.error('[get-one] usage: node get-entry.mjs <id>');
  process.exit(1);
}

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[get-one] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}

if (!token.access_token) {
  console.error('[get-one] .token.json is missing access_token. Run auth.mjs first.');
  process.exit(1);
}

// Tenant base URL. BQE returns an `endpoint` field in the token response
// that points to the tenant-specific API host (e.g.
// https://api.bqecore.com/api/). Mirror the production Jot app's axios
// baseURL here; fall back to BQE_API_BASE for edge cases where the token
// response didn't carry an endpoint.
const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!apiBase) {
  console.error('[get-one] No tenant endpoint in .token.json and no BQE_API_BASE in .env');
  process.exit(1);
}

// Negated to match BQE's convention (and how the Jot app's bqeClient sets
// it). Server-side BQE uses this to localise the entry's wall-clock date.
const utcOffset = String(-new Date().getTimezoneOffset());

const url = `${apiBase}/timeentry/${encodeURIComponent(id)}`;
log('GET   =', url);
log('token =', token.access_token.slice(0, 16) + '… (length ' + token.access_token.length + ')');
log('X-UTC-OFFSET =', utcOffset);

const resp = await fetch(url, {
  method: 'GET',
  headers: {
    authorization: `Bearer ${token.access_token}`,
    accept: 'application/json',
    'x-utc-offset': utcOffset,
  },
});

log('status =', resp.status, resp.statusText);
log('headers =');
for (const [k, v] of resp.headers.entries()) {
  console.log(`         ${k}: ${v}`);
}

const text = await resp.text();
log('body length =', text.length);

// Always try to parse as JSON first — BQE returns JSON for both success
// envelopes and error envelopes (e.g. { "errorCode": "...", "message": "..." }),
// and we want to see the full body whether the request was 2xx or not.
let parsed = null;
try {
  parsed = text.length > 0 ? JSON.parse(text) : null;
} catch {
  // not JSON — fall through to raw text below
}

if (parsed !== null) {
  log('body (parsed) =');
  console.log(JSON.stringify(parsed, null, 2));
} else {
  log('body (raw) =');
  console.log(text.slice(0, 4000));
  if (text.length > 4000) {
    log(`(truncated — full body was ${text.length} chars)`);
  }
}

if (resp.status === 401) {
  console.log('');
  log('Token expired — re-run auth.mjs');
  process.exit(2);
}

if (!resp.ok) {
  console.log('');
  log('REQUEST FAILED. Look at the body above for BQE\'s error envelope.');
  process.exit(1);
}

log('OK — entry fetched.');
process.exit(0);
