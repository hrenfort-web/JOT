#!/usr/bin/env node
//
// bqe-test/post-entry.mjs
//
// POST /timeentry with explicit project/activity/resource/etc. arguments so
// we can isolate the 409 ProjectControlLimitation error from the Jot app's
// surrounding logic. Pretty-prints the full request + response.
//
// Usage:
//   node post-entry.mjs \
//     --projectId=<uuid> \
//     --activityId=<uuid> \
//     --resourceId=<uuid> \
//     --date=2025-05-07 \
//     --hours=1.5 \
//     --memo="Diagnostic post" \
//     --billable=true

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const log = (...args) => console.log('[post]', ...args);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const args = parseArgs(process.argv.slice(2));

const required = ['projectId', 'activityId', 'resourceId', 'date', 'hours'];
const missing = required.filter((k) => args[k] == null || args[k] === '');
if (missing.length > 0) {
  console.error('[post] missing required args:', missing.join(', '));
  console.error(
    '[post] usage: node post-entry.mjs --projectId=... --activityId=... --resourceId=... --date=YYYY-MM-DD --hours=1.5 [--memo="..."] [--billable=true|false]',
  );
  process.exit(1);
}

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[post] No .token.json found. Run `node auth.mjs` first.');
  process.exit(1);
}
if (!token.access_token) {
  console.error('[post] .token.json is missing access_token. Re-run auth.mjs.');
  process.exit(1);
}

const billable = args.billable == null ? true : args.billable === 'true';
const memo = args.memo ?? '';

// Body shape mirrors what the Jot app sends via services/bqe/timeentry.ts.
// Both `description` and `memo` are populated because BQE has historically
// expected both on POST and some envelopes pick one or the other.
const body = {
  projectId: args.projectId,
  activityId: args.activityId,
  resourceId: args.resourceId,
  date: args.date,
  actualHours: Number(args.hours),
  billable,
  description: memo,
  memo,
};

// Prefer the tenant endpoint that BQE returned with the token (matches
// production Jot app behavior); fall back to BQE_API_BASE from .env.
const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!apiBase) {
  console.error('[post] No tenant endpoint in .token.json and no BQE_API_BASE in .env');
  process.exit(1);
}

const utcOffset = String(-new Date().getTimezoneOffset());
const url = `${apiBase}/timeentry`;

log('=== REQUEST ===');
log('POST  =', url);
log('headers =');
console.log(`         authorization: Bearer ${token.access_token.slice(0, 16)}… (length ${token.access_token.length})`);
console.log('         content-type: application/json');
console.log('         accept: application/json');
console.log(`         x-utc-offset: ${utcOffset}`);
log('body =');
console.log(JSON.stringify(body, null, 2));

const resp = await fetch(url, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token.access_token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'x-utc-offset': utcOffset,
  },
  body: JSON.stringify(body),
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

// Always try to parse as JSON first — BQE error responses are JSON envelopes
// (e.g. { "errorCode": "031.001", "message": "ProjectControlLimitation..." })
// and pretty-printing makes them much easier to read in the terminal.
let parsed = null;
try {
  parsed = text.length > 0 ? JSON.parse(text) : null;
} catch {
  // not JSON — fall through
}

if (parsed !== null) {
  log('body (parsed) =');
  console.log(JSON.stringify(parsed, null, 2));
} else {
  log('body (raw) =');
  console.log(text);
}

if (!resp.ok) {
  console.log('');
  log('REQUEST FAILED. Look at the body above for BQE\'s error envelope.');
  log('Common 409 causes:');
  log('  - ProjectControlLimitation: activityId is not in the project\'s group.');
  log('    Fix by passing an activityId that belongs to the project\'s assigned group.');
  log('  - Project locked / billed: try a different project or an unbilled date.');
  log('  - Date outside an allowed period.');
  process.exit(3);
}

// Body was already pretty-printed once in the response section above; this
// success branch just surfaces the created id so it's easy to copy for a
// follow-up get-entries.mjs call. Reuses the same `parsed` from the
// response-section parse — no need to re-parse `text` a second time.
if (parsed !== null) {
  log('created id =', parsed?.id ?? '<missing>');
} else {
  log('created id =', '<missing>');
}

log('OK — entry created. Pull it back with get-entries.mjs to confirm.');

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
