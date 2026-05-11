# bqe-test

Dev-only harness for prodding the BQE Core API directly. Built to diagnose
the 409 ProjectControlLimitation error we see on `POST /timeentry` from the
Jot app, without the React Native runtime in the way.

This folder is **isolated from the main Jot app**:

- Separate `package.json` so its dependencies (`dotenv`, `open`) don't
  touch the Expo lockfile.
- All scripts are plain Node 20 ESM with built-in `fetch`.
- Uses a separate "Jot Testing" OAuth app registered on the BQE Developer
  Portal so production credentials stay clean.

## Setup (one-time)

```bash
cd bqe-test
npm install
cp .env.example .env
# Edit .env and paste the "Jot Testing" client id + client secret from
# the BQE Developer Portal. Confirm BQE_API_BASE matches your tenant.
```

The redirect URI `http://localhost:8765/callback` **must** be registered for
the "Jot Testing" app in the Developer Portal — that's where the OAuth
provider sends the user back after consent.

## 1. Authenticate

```bash
node auth.mjs
```

What happens:

1. Spins up a local HTTP server on port 8765.
2. Opens your default browser to the BQE authorize URL with `response_type=code`.
3. After you log in and approve, BQE redirects to `http://localhost:8765/callback?code=…`.
4. The script captures the code, POSTs to the token endpoint with HTTP Basic
   auth (`client_id:client_secret`), and writes the full token response —
   including `refresh_token` since the scope includes `offline_access` — to
   `.token.json` next to the script.
5. Logs every step with `[auth]` prefix.

`.token.json` is gitignored. The access token is good for ~1 hour; just
re-run `auth.mjs` whenever it expires. (For a future enhancement, a
`refresh.mjs` could swap the refresh token for a fresh access token without
re-prompting in the browser.)

## 2. Verify auth — GET /timeentry

```bash
node get-entries.mjs
```

Dumps the HTTP status, every response header, and the first 3 entries (or
the full body if it's not an array). If you see a 401, the token expired —
re-run `auth.mjs`.

## 3. Test POST — reproduce the 409

```bash
node post-entry.mjs \
  --projectId=<phase-uuid> \
  --activityId=<activity-uuid> \
  --resourceId=<your-employee-uuid> \
  --date=2025-05-07 \
  --hours=1.5 \
  --memo="Diagnostic post" \
  --billable=true
```

Prints the full request (URL, headers with token redacted, JSON body) then
the full response (status, headers, parsed JSON body). On error the parsed
body is pretty-printed so you can read BQE's error envelope directly —
typically `{ "errorCode": "031.001", "message": "ProjectControlLimitation..." }`.

### Reproducing the 409

1. Pick an activity that **isn't** in the project's group → 409
   ProjectControlLimitation expected.
2. Pick the activity that **is** in the project's group → 201 / 200 expected.
3. Pull `/projectassignment` and `/group/detail` separately (next iteration:
   add `get-projectassignments.mjs` and `get-groups.mjs`) to confirm which
   activities are allowed per group.

## File map

```
bqe-test/
  .env.example      template — copy to .env and fill in
  .env              REAL credentials (gitignored)
  .token.json       cached tokens from auth.mjs (gitignored)
  .gitignore        ignores .env, .token.json, node_modules, lockfiles
  auth.mjs          OAuth code-flow handshake
  get-entries.mjs   GET /timeentry sanity check
  post-entry.mjs    POST /timeentry with CLI args
  package.json      dotenv + open
```

## Troubleshooting

- **Browser opens to a "page can't be reached" error after consent** — the
  registered redirect URI on the Developer Portal doesn't match
  `http://localhost:8765/callback`. Update it on the portal exactly,
  including the path and port.
- **`address already in use :::8765`** — another process is holding the
  port. Either change `BQE_REDIRECT_URI` in `.env` to a different port (and
  update the Developer Portal to match) or kill the conflicting process.
- **Token exchange returns `invalid_client`** — `BQE_TEST_CLIENT_SECRET` is
  wrong, or the registered app is a Native app (which doesn't use a
  secret). Re-register on the Developer Portal as a "Regular Web App" or
  similar confidential client type.
- **`coreapi1-01.bqecore.com` doesn't resolve / returns 404 on /timeentry**
  — your tenant uses a different regional host. Check the Developer Portal
  "API URL" field for the actual base URL.
