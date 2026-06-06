#!/usr/bin/env node
//
// bqe-test/delete-entry.mjs
//
// DESTRUCTIVE: deletes a single time entry from the live BQE tenant by id.
// This hits PRODUCTION data — the entry is gone after a 2xx response. Use
// only to clean up rows created by post-entry.mjs during diagnostics.
//
// Usage:
//   node delete-entry.mjs <entryId>
//
// Note the positional id — NOT --id=. Mirrors how BQE's own docs describe
// the endpoint: DELETE {endpoint}/timeentry/{id}.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const log = (...args) => console.log('[delete]', ...args);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const entryId = process.argv[2];
if (!entryId) {
  console.error('[delete] missing entry id');
  console.error('[delete] usage: node delete-entry.mjs <entryId>');
  process.exit(1);
}

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[delete] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}

if (!token.access_token) {
  console.error('[delete] .token.json is missing access_token. Re-run auth.mjs.');
  process.exit(1);
}

// Prefer the tenant endpoint that BQE returned with the token (matches the
// production Jot app); fall back to BQE_API_BASE from .env for edge cases.
const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!apiBase) {
  console.error('[delete] No tenant endpoint in .token.json and no BQE_API_BASE in .env');
  process.exit(1);
}

// Negated to match BQE's convention (and how the Jot app's bqeClient sets
// it). Server-side BQE uses this to localise the entry's wall-clock date.
const utcOffset = String(-new Date().getTimezoneOffset());

const url = `${apiBase}/timeentry/${encodeURIComponent(entryId)}`;

log('=== REQUEST ===');
log('DELETE =', url);
log('token  =', token.access_token.slice(0, 16) + '… (length ' + token.access_token.length + ')');
log('X-UTC-OFFSET =', utcOffset);

const resp = await fetch(url, {
  method: 'DELETE',
  headers: {
    authorization: `Bearer ${token.access_token}`,
    accept: 'application/json',
    'x-utc-offset': utcOffset,
  },
});

console.log('');
log('=== RESPONSE ===');
log('status =', resp.status, resp.statusText);
log('headers =');
for (const [k, v] of resp.headers.entries()) {
  console.log(`         ${k}: ${v}`);
}

const text = await resp.text();
log('body length =', text.length);

// BQE typically returns 204 No Content on a successful DELETE, so the body
// is often empty. Don't try to JSON.parse an empty string — just note it.
if (resp.status === 204 || text.length === 0) {
  log('body (empty)');
} else {
  // Always try to parse as JSON first — BQE error responses are JSON
  // envelopes (e.g. { "errorCode": "...", "message": "..." }) and
  // pretty-printing makes them much easier to read in the terminal.
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON — fall through
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
}

if (resp.status === 401) {
  console.log('');
  log('Token expired — re-run auth.mjs');
  process.exit(2);
}

if (!resp.ok) {
  console.log('');
  log('DELETE FAILED. Look at the body above for BQE\'s error envelope.');
  process.exit(1);
}

log(`OK — entry ${entryId} deleted.`);
process.exit(0);
