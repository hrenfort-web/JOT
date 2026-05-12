#!/usr/bin/env node
//
// bqe-test/refresh.mjs
//
// Trade the cached refresh_token in .token.json for a fresh access_token.
// Avoids re-running auth.mjs every time the 1-hour access token expires.
// On success, rewrites .token.json in place with the new access_token,
// new expires_at, and (if BQE rotates it) a new refresh_token.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const log = (...args) => console.log('[refresh]', ...args);

const { BQE_TEST_CLIENT_ID, BQE_TEST_CLIENT_SECRET, BQE_TOKEN_URL } = process.env;
if (!BQE_TEST_CLIENT_ID || !BQE_TEST_CLIENT_SECRET || !BQE_TOKEN_URL) {
  console.error('[refresh] Missing env vars (BQE_TEST_CLIENT_ID / SECRET / TOKEN_URL).');
  process.exit(1);
}

let stored;
try {
  stored = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[refresh] No .token.json — run `node auth.mjs` first.');
  process.exit(1);
}

if (!stored.refresh_token) {
  console.error('[refresh] No refresh_token in .token.json. Run `node auth.mjs`.');
  process.exit(1);
}

const basic = Buffer.from(`${BQE_TEST_CLIENT_ID}:${BQE_TEST_CLIENT_SECRET}`).toString('base64');
const body = new URLSearchParams({
  grant_type: 'refresh_token',
  refresh_token: stored.refresh_token,
});

log('POST', BQE_TOKEN_URL, '(grant_type=refresh_token)');
const resp = await fetch(BQE_TOKEN_URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    authorization: `Basic ${basic}`,
  },
  body: body.toString(),
});

const text = await resp.text();
log('status =', resp.status);
if (!resp.ok) {
  console.error('[refresh] token exchange FAILED');
  console.error('[refresh] body =', text);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(text);
} catch {
  console.error('[refresh] response was not JSON:', text);
  process.exit(1);
}

const expiresInSec = Number(json.expires_in ?? 3600);
const next = {
  ...stored, // preserve `endpoint` etc.
  ...json,
  // BQE may not echo refresh_token back if it's not rotating — preserve.
  refresh_token: json.refresh_token ?? stored.refresh_token,
  expiresAt: Date.now() + expiresInSec * 1000,
  obtainedAt: Date.now(),
};

await fs.writeFile(TOKEN_FILE, JSON.stringify(next, null, 2), 'utf8');
log('access_token length =', String(next.access_token ?? '').length);
log('expires_in (s)      =', expiresInSec);
log('expires at          =', new Date(next.expiresAt).toISOString());
log('endpoint            =', next.endpoint ?? '(none)');
log('wrote', TOKEN_FILE);
