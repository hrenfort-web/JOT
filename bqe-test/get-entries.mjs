#!/usr/bin/env node
//
// bqe-test/get-entries.mjs
//
// Sanity-check that the saved access_token works: GET /timeentry and dump
// the response. Use this after running auth.mjs to confirm credentials and
// API base URL before attempting any POST tests.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const log = (...args) => console.log('[get]', ...args);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[get] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}

if (!token.access_token) {
  console.error('[get] .token.json is missing access_token. Re-run auth.mjs.');
  process.exit(1);
}

// Tenant base URL. BQE returns an `endpoint` field in the token response
// that points to the tenant-specific API host (e.g.
// https://api.bqecore.com/api/). The production Jot app uses this value
// as its axios baseURL — we mirror that here. The env-var fallback is for
// edge cases where the token response doesn't carry an endpoint.
const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!apiBase) {
  console.error('[get] No tenant endpoint in .token.json and no BQE_API_BASE in .env');
  process.exit(1);
}

// Negated to match BQE's convention (and how the Jot app's bqeClient sets
// it). Server-side BQE uses this to localise the entry's wall-clock date.
const utcOffset = String(-new Date().getTimezoneOffset());

const url = `${apiBase}/timeentry`;
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

log('status  =', resp.status, resp.statusText);
log('headers =');
for (const [k, v] of resp.headers.entries()) {
  console.log(`         ${k}: ${v}`);
}

const text = await resp.text();
log('body length =', text.length);

if (resp.status === 401) {
  console.log('');
  console.log('[get] Token expired — re-run auth.mjs');
  process.exit(2);
}

// Try JSON pretty-print; fall back to raw text. Truncate to keep stdout
// readable when the tenant returns thousands of rows.
try {
  const json = JSON.parse(text);
  const sample = Array.isArray(json) ? json.slice(0, 3) : json;
  log('body (parsed) =');
  console.log(JSON.stringify(sample, null, 2));
  if (Array.isArray(json) && json.length > 3) {
    log(`(truncated — full array had ${json.length} rows)`);
  }
} catch {
  log('body (raw) =');
  console.log(text.slice(0, 4000));
  if (text.length > 4000) {
    log(`(truncated — full body was ${text.length} chars)`);
  }
}
