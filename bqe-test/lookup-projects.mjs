#!/usr/bin/env node
//
// bqe-test/lookup-projects.mjs
//
// Resolve BQE project UUIDs by project code. Useful for seeding firm
// settings, debugging "which project is that?", and one-off audits.
//
// Usage:
//   node lookup-projects.mjs 0000.00 0000.01 0000.02 0000.03
//   node lookup-projects.mjs 2024.005    # single code also fine
//
// Endpoint: GET /project?where=code='<code>'&fields=id,name,code
// Output: one line per requested code with { code, id, name } in JSON form.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const codes = process.argv.slice(2);
if (codes.length === 0) {
  console.error('[lookup] usage: node lookup-projects.mjs <code> [<code> …]');
  process.exit(1);
}

let token;
try {
  token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
} catch {
  console.error('[lookup] No .token.json — run `node auth.mjs` or `node refresh.mjs`.');
  process.exit(1);
}

const apiBase = (token.endpoint ?? process.env.BQE_API_BASE ?? '').replace(/\/+$/, '');
if (!token.access_token || !apiBase) {
  console.error('[lookup] Token or endpoint missing — re-run auth/refresh.');
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${token.access_token}`,
  accept: 'application/json',
  'x-utc-offset': String(-new Date().getTimezoneOffset()),
};

console.log(`[lookup] resolving ${codes.length} project code(s) against ${apiBase}`);

// Run sequentially; the rate limit (100/min) is plenty for a handful of
// codes, and sequential output reads more naturally than interleaved
// parallel logs.
const results = [];
for (const code of codes) {
  const search = new URLSearchParams();
  search.set('where', `code='${code}'`);
  search.set('fields', 'id,name,code');
  const url = `${apiBase}/project?${search.toString()}`;
  try {
    const resp = await fetch(url, { method: 'GET', headers });
    const text = await resp.text();
    if (!resp.ok) {
      console.log(`[lookup] ${code} → HTTP ${resp.status}: ${text.slice(0, 200)}`);
      results.push({ code, error: `HTTP ${resp.status}` });
      continue;
    }
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : (data?.value ?? data?.data ?? data?.items ?? []);
    if (rows.length === 0) {
      console.log(`[lookup] ${code} → NO MATCH`);
      results.push({ code, error: 'no match' });
    } else if (rows.length === 1) {
      const r = rows[0];
      console.log(JSON.stringify({ code: r.code, id: r.id, name: r.name }));
      results.push({ code: r.code, id: r.id, name: r.name });
    } else {
      console.log(`[lookup] ${code} → ${rows.length} matches:`);
      for (const r of rows) {
        console.log('  ', JSON.stringify({ code: r.code, id: r.id, name: r.name }));
      }
      results.push({ code, matches: rows.map((r) => ({ code: r.code, id: r.id, name: r.name })) });
    }
  } catch (e) {
    console.log(`[lookup] ${code} → ERROR ${e.message}`);
    results.push({ code, error: e.message });
  }
}

console.log('');
console.log('[lookup] === SUMMARY ===');
for (const r of results) {
  if (r.id) {
    console.log(`  ${r.code.padEnd(10)} → ${r.id}  (${r.name})`);
  } else if (r.matches) {
    console.log(`  ${r.code.padEnd(10)} → ${r.matches.length} matches (see above)`);
  } else {
    console.log(`  ${r.code.padEnd(10)} → ${r.error}`);
  }
}
