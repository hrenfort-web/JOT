#!/usr/bin/env node
//
// bqe-test/auth.mjs
//
// One-shot OAuth authorization-code flow for the "Jot Testing" BQE app.
// Spins up a tiny localhost HTTP server, opens the system browser to the
// BQE authorize URL, captures the redirect, exchanges the code for tokens,
// and writes the full token response to .token.json next to this script.
//
// Confidential-client flow (uses client_secret via Basic auth). PKCE is
// deliberately omitted — this is a Regular Web App in BQE Portal terms,
// not a Native app, so it has a real secret and can also receive a
// refresh_token via the `offline_access` scope.

import http from 'node:http';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import open from 'open';

const log = (...args) => console.log('[auth]', ...args);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.token.json');

const {
  BQE_TEST_CLIENT_ID,
  BQE_TEST_CLIENT_SECRET,
  BQE_AUTHORIZE_URL,
  BQE_TOKEN_URL,
  BQE_REDIRECT_URI,
} = process.env;

if (
  !BQE_TEST_CLIENT_ID ||
  !BQE_TEST_CLIENT_SECRET ||
  !BQE_AUTHORIZE_URL ||
  !BQE_TOKEN_URL ||
  !BQE_REDIRECT_URI
) {
  console.error(
    '[auth] Missing env vars. Copy .env.example to .env and fill in client id/secret.',
  );
  process.exit(1);
}

const SCOPE = 'read:core readwrite:core openid offline_access';
const state = randomBytes(16).toString('hex');

// Parse redirect URI so the local server binds to exactly the same port BQE
// will redirect to. Catches the common "registered URI doesn't match what
// the script listens on" misconfiguration.
const redirect = new URL(BQE_REDIRECT_URI);
const PORT = Number(redirect.port || '80');
const CALLBACK_PATH = redirect.pathname || '/callback';

log('redirectUri      =', BQE_REDIRECT_URI);
log('callback host    =', `${redirect.hostname}:${PORT}${CALLBACK_PATH}`);
log('clientId         =', BQE_TEST_CLIENT_ID.slice(0, 12) + '…');
log('clientSecret set =', BQE_TEST_CLIENT_SECRET.length > 0);
log('scope            =', SCOPE);
log('state            =', state);

const authorizeUrl = new URL(BQE_AUTHORIZE_URL);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', BQE_TEST_CLIENT_ID);
authorizeUrl.searchParams.set('redirect_uri', BQE_REDIRECT_URI);
authorizeUrl.searchParams.set('scope', SCOPE);
authorizeUrl.searchParams.set('state', state);

log('FULL authorize URL =', authorizeUrl.toString());

// Promise resolved by the HTTP server callback with the captured code.
const awaitCode = new Promise((resolve, reject) => {
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('Missing URL');
      return;
    }
    const reqUrl = new URL(req.url, `http://${redirect.hostname}:${PORT}`);
    log('callback hit     =', reqUrl.pathname, 'params=', Object.fromEntries(reqUrl.searchParams));

    if (reqUrl.pathname !== CALLBACK_PATH) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const err = reqUrl.searchParams.get('error');
    if (err) {
      const desc = reqUrl.searchParams.get('error_description') ?? '';
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>OAuth error</h1><pre>${err}\n${desc}</pre>`);
      server.close();
      reject(new Error(`OAuth error: ${err} ${desc}`));
      return;
    }

    const code = reqUrl.searchParams.get('code');
    const returnedState = reqUrl.searchParams.get('state');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>No code in callback</h1>');
      server.close();
      reject(new Error('No code in callback'));
      return;
    }
    if (returnedState !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>State mismatch</h1>');
      server.close();
      reject(new Error(`State mismatch: sent ${state}, got ${returnedState}`));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><body style="font-family:system-ui;padding:32px"><h2>Authenticated.</h2><p>You can close this tab and return to the terminal.</p></body></html>',
    );

    // Tear down the server before the token exchange — the exchange is
    // server-to-server and doesn't need the listener anymore.
    server.close();
    resolve(code);
  });

  server.on('error', (e) => reject(e));
  server.listen(PORT, redirect.hostname, () => {
    log('listening for callback on', `http://${redirect.hostname}:${PORT}${CALLBACK_PATH}`);
  });
});

log('opening browser to authorize URL …');
await open(authorizeUrl.toString());

let code;
try {
  code = await awaitCode;
} catch (e) {
  console.error('[auth] FAILED:', e.message);
  process.exit(1);
}

log('captured code    =', code.slice(0, 20) + '…');
log('exchanging code for tokens …');

// Token exchange uses HTTP Basic auth with the client credentials, per
// OAuth 2.0 RFC 6749 §2.3.1 (and what BQE's API explorer shows for
// confidential clients).
const basic = Buffer.from(`${BQE_TEST_CLIENT_ID}:${BQE_TEST_CLIENT_SECRET}`).toString('base64');
const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: BQE_REDIRECT_URI,
});

const tokenResp = await fetch(BQE_TOKEN_URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    authorization: `Basic ${basic}`,
  },
  body: body.toString(),
});

const tokenText = await tokenResp.text();
log('token endpoint status =', tokenResp.status);

if (!tokenResp.ok) {
  console.error('[auth] token exchange FAILED');
  console.error('[auth] response body =', tokenText);
  process.exit(1);
}

let tokenJson;
try {
  tokenJson = JSON.parse(tokenText);
} catch (e) {
  console.error('[auth] token response was not JSON:', tokenText);
  process.exit(1);
}

// Augment the persisted token with derived fields so other scripts don't
// have to recompute them. `expiresAt` is the absolute wall-clock time the
// access_token becomes invalid, so a `Date.now() >= expiresAt` check is
// enough to decide whether to refresh or re-auth.
const expiresInSec = Number(tokenJson.expires_in ?? 3600);
tokenJson.expiresAt = Date.now() + expiresInSec * 1000;
tokenJson.obtainedAt = Date.now();

await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenJson, null, 2), 'utf8');

log('keys in token response =', Object.keys(tokenJson));
log('access_token length    =', String(tokenJson.access_token ?? '').length);
log('refresh_token present  =', !!tokenJson.refresh_token);
log('expires_in (s)         =', expiresInSec);
log('expires at             =', new Date(tokenJson.expiresAt).toISOString());
log('endpoint (if present)  =', tokenJson.endpoint ?? tokenJson.api_endpoint ?? '(none)');
log('wrote', TOKEN_FILE);
log('done.');
