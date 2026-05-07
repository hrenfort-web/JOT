# Jot — Code Audit

**Date**: 2026-05-07
**Scope**: Full repo (excluding node_modules, build artifacts, and historical playbook docs)
**Status**: Findings only — no fixes applied. Discuss and prioritize before action.

Severity legend:

- 🔴 **CRITICAL** — security risk or guaranteed crash
- 🟠 **HIGH** — data loss or significant UX problem
- 🟡 **MEDIUM** — should fix soon
- 🟢 **LOW** — nice to have / informational

---

## 1. Security

### 🔴 S-1: Anthropic API key shipped inside the JS bundle
- **Where**: `services/ai/scanner.ts:46` reads `process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY`
- **Issue**: Any env var prefixed `EXPO_PUBLIC_` is inlined into the JS bundle at build time. Anyone who downloads the IPA from TestFlight (let alone the App Store) can extract the key in minutes via `strings` or a JS deobfuscator and run unlimited Claude inference billed to your Anthropic account.
- **Acknowledged in code**: comment at `services/ai/scanner.ts:1-2` flags this as v2 work — server-side proxy via Supabase Edge Function.
- **Suggested fix**: stand up the proxy before broader rollout. Until then, rotate the key on any suspected leak and watch Anthropic spend daily.

### 🔴 S-2: BQE OAuth client_secret shipped inside the JS bundle
- **Where**: `services/bqe/auth.ts:62` reads `process.env.EXPO_PUBLIC_BQE_CLIENT_SECRET`; passed to `getAuthRequestConfig`, `exchangeCodeAsync`, and `refreshAsync`
- **Issue**: Same exfiltration risk as S-1. A leaked client secret lets an attacker impersonate Jot to BQE during the OAuth flow, potentially redirecting tokens.
- **Compounding**: BQE's Native-app OAuth flow with PKCE doesn't actually require a client secret (the comment at `services/bqe/auth.ts:15-26` notes BQE rejects `offline_access` for Native apps because they're treated as public clients). The client_secret may be unnecessary — verify with BQE support and remove if so.
- **Suggested fix**: confirm with BQE whether the secret is required for Native apps. If not, drop it. If required, move OAuth through the same server-side proxy as S-1.

### 🟡 S-3: PII logged in dev (userinfo claims)
- **Where**: `services/bqe/auth.ts:108-110`
- **Issue**: `console.log('[jot:auth]    claims =', data)` dumps full userinfo payload (email, name, sub) to the dev console. Dev-only (`__DEV__`-gated), but could leak via screen-sharing during a debugging session.
- **Suggested fix**: log only field names + truthiness, not values. `Object.keys(data)` rather than `data`.

### 🟡 S-4: OAuth params logged in dev
- **Where**: `app/auth/login.tsx:40-48` logs full authorize URL, codeChallenge, state
- **Issue**: Dev-only. Codeverifier is already truncated to first 8 chars. State param is logged whole — generally not sensitive, but the full authorize URL contains the redirectUri and other tenant identifiers worth keeping out of casual screenshots.
- **Suggested fix**: lower fidelity — log lengths/presence rather than full values.

### 🟢 S-5: SQL injection — clean
- **Searched**: all `SELECT|INSERT|UPDATE|DELETE` sites
- **Findings**: every value-bearing query uses `?` placeholders. The string interpolation that exists is in:
  - `db/database.ts:61-62` — table/column names from caller code (developer-controlled)
  - `services/demo/seedData.ts:115-118` — a hardcoded const prefix
  - `services/bqe/timeentry.ts:412` — fixed `'col = ?'` literals composed via array
- **No user-input concatenation found.** Safe.

### 🟢 S-6: Token storage uses SecureStore (not AsyncStorage)
- **Where**: `services/bqe/auth.ts:144-156`
- **Findings**: `bqe_oauth_tokens` stored via `SecureStore.setItemAsync` (iOS Keychain). Correct.

---

## 2. Error Handling

### 🟠 E-1: Raw error messages bubble to user-facing UI
- **Where**: `services/sync/queue.ts:91-108`, `store/useEntryStore.ts:217-224`, `store/useEntryStore.ts:128-129`
- **Issue**: `e instanceof Error ? e.message : 'Submit failed'` for axios errors yields strings like `Request failed with status code 422` or full BQE error bodies — opaque and frightening to end users.
- **Suggested fix**: route through `formatError()` (already exists in `services/errors.ts` — used by login but not the entry submit path).

### 🟡 E-2: Many silent `catch {}` blocks
- **Where**: `utils/preferences.ts:8,16,49,57`, `services/bqe/auth.ts:153,175`, `services/notifications/reminders.ts:137,149`, `db/database.ts:16`, `services/sync/queue.ts:38,40`, `services/sync/connectivity.ts:34,39`, `services/bqe/timeentry.ts:176`
- **Issue**: Most are intentionally swallowing non-critical errors (preference parse failures, notification listener noise). `db/database.ts:16` swallows duplicate-column migration errors which is correct, but the same pattern hides genuinely unknown errors during migration.
- **Suggested fix**: leave the genuinely benign ones alone; add a single `console.warn` (gated on `__DEV__`) so unexpected failures aren't completely invisible during dev.

### 🟡 E-3: Haptics calls `.catch(() => {})` everywhere
- **Where**: 13 sites across `app/(tabs)/scan.tsx`, `app/entry/hours.tsx`, `store/useToastStore.ts`
- **Issue**: Acceptable — haptics failing on unsupported devices is benign — but the pattern is verbose. Worth a `safeHaptic()` helper.
- **Severity**: Low cosmetic.

---

## 3. Performance

### 🟠 P-1: No `FlatList` anywhere — all lists use `ScrollView`
- **Where**: confirmed via `Grep "FlatList"` → 0 hits, `Grep "ScrollView"` → 7 files
- **Worst offender**: `app/entry/picker.tsx:68` ScrollView renders the entire `tree` (3,226 projects on Studio G's tenant) when the search input is empty. Every project is a `Pressable` with an icon and 1–2 text rows. Mounting cost on first open is real.
- **Other heavy lists**: `app/entry/[projectId].tsx` (PhaseList rows), `app/scan/review.tsx` (entry rows), `components/ProjectPickerModal.tsx`
- **Suggested fix**: convert the picker ScrollView to a FlatList with `keyExtractor`, `getItemLayout` (rows are fixed height), and `windowSize={5}`. ProjectCard list on home is already capped by bucket logic — lower priority.

### 🟡 P-2: Inline arrow functions in list-row props
- **Where**: `app/(tabs)/index.tsx:485` — `<ProjectCard onPress={() => router.push(...)} />`
- **Issue**: Currently a non-issue with ScrollView (every render rebuilds anyway). Becomes relevant after P-1 fix — without `React.memo` + stable `onPress`, FlatList virtualization can't cache rows.
- **Suggested fix**: pair with P-1. Add `useCallback` for the press handler and `React.memo(ProjectCard)`.

### 🟢 P-3: Home screen useMemo coverage looks correct
- **Findings**: `hoursByDay`, `phaseToParent`, `hoursByParent`, `projectBuckets`, `visibleProjects`, `groups` are all memoized with sensible deps.

---

## 4. Tech Debt

### 🟠 T-1: Require cycle — `useAuthStore` ↔ `initialSync`
- **Where**: `store/useAuthStore.ts:18` imports `runInitialSync`; `services/sync/initialSync.ts:5-7` imports `useAuthStore`, `useProjectStore`, `useEntryStore`
- **Issue**: Cycle is benign at runtime because both sides only call into each other after module init, but Metro warns on it and it complicates module load order.
- **Suggested fix**: `useAuthStore.login` could dispatch a "post-login" event (or accept an optional `onSuccess` callback) that the layout hooks observe, rather than directly importing `runInitialSync`. Alternative: move `runInitialSync`'s store-refresh tail into a callback passed in by the auth flow.

### 🟠 T-2: Require cycle — `bqeClient` ↔ `useAuthStore`
- **Where**: `services/bqe/client.ts:2` imports `useAuthStore`; `useAuthStore` indirectly imports `client.ts` through `auth.ts` chain
- **Issue**: Same as T-1.
- **Suggested fix**: pass tokens into `bqeClient` via a getter set by the auth store at init time, instead of the client reaching into the store directly.

### 🟡 T-3: Lazy `require` workaround
- **Where**: `services/bqe/timeentry.ts:172-178`
- **Status**: Already commented as a deliberate cycle-break. Acceptable but indicative of the underlying T-1/T-2 problem.

### 🟡 T-4: `SafeAreaView` from `react-native` is deprecated (RN ≥ 0.72)
- **Where**: `app/(tabs)/scan.tsx:6`, `app/(tabs)/settings.tsx:6`, `app/(tabs)/index.tsx:7`, `app/entry/picker.tsx:4`, `components/ProjectPickerModal.tsx:1`
- **Suggested fix**: import from `react-native-safe-area-context` instead. Mechanical change, no API differences.

### 🟡 T-5: SecureStore used for non-secret data
- **Where**: `services/sync/initialSync.ts:9, 100, 105` — `LAST_SYNC_KEY` (an ISO timestamp); `services/notifications/reminders.ts:74` — `notifPermissionAsked` boolean flag
- **Issue**: SecureStore writes to iOS Keychain. It has a 2048-byte item limit (we've hit warnings on this before for the OAuth token blob) and is overkill for plain preferences. Plain timestamps and booleans should use `AsyncStorage` or a SQLite KV row.
- **Suggested fix**: introduce a thin `prefs.ts` wrapper around AsyncStorage; migrate `LAST_SYNC_KEY` and `notifPermissionAsked` over.

### 🟡 T-6: `typography` constant defined but never used
- **Where**: `theme.ts:99-103`
- **Issue**: Exported but every component sets fontSize/fontWeight inline. Either adopt it or delete it.
- **Suggested fix**: delete (the inline sizes are highly contextual; a shared scale doesn't fit how the app is built).

### 🟡 T-7: Dark mode infrastructure unused
- **Where**: `theme.ts:65-83` defines a full `darkColors` palette and `useColors()` hook (`theme.ts:94-96`). The only consumer of `useColorScheme` is `_layout.tsx:48` — for the StatusBar bar style. Every component imports the static `colors` (light only).
- **Suggested fix**: either commit to dark mode (refactor every component to call `useColors()`) or delete the dark palette and `useColors` until it's actually scoped. Currently it's misleading dead infrastructure.

---

## 5. Code Quality

### 🟡 Q-1: `any` types in OAuth response handling
- **Where**: `services/bqe/auth.ts:75, 129, 141`
- **Issue**: `tokenResponseToStored(raw: any)` and `(result as any).rawResponse` casts. The OAuth response shape *is* genuinely loose (BQE serialises some fields snake_case, some camelCase), but the input type could narrow to `Record<string, unknown>` and field reads use `as string | undefined`.
- **Suggested fix**: tighten to `Record<string, unknown>` with safer property reads.

### 🟢 Q-2: Two outstanding TODOs
- `services/bqe/auth.ts:22` — auth-strategy decision (re-auth vs. server proxy). Tied to S-1/S-2.
- `services/bqe/timeentry.ts:376` — exact submit body shape pending BQE support confirmation. Reasonable; tracked.

### 🟡 Q-3: Inconsistent error-formatting paths
- **Issue**: `services/errors.ts` defines `formatError` and `logError`. `formatError` is used by `app/auth/login.tsx` and `services/bqe/employee.ts`; the entry-submit path bypasses it (`store/useEntryStore.ts:222`). User-facing copy quality varies.
- **Suggested fix**: route every user-facing error message through `formatError`.

---

## 6. Data Integrity

### 🟢 D-1: Schema migrations idempotent
- **Where**: `db/database.ts:14-19` — each migration wrapped in try/catch that swallows duplicate-column errors. Migration list in `db/schema.ts:1-11` is append-only.
- **Verdict**: handles existing installs correctly.

### 🟡 D-2: Sync queue race / duplicate-write window
- **Where**: `services/sync/queue.ts` — module-level `processing` flag; entries are marked `'synced'` only after `markEntrySyncedWithBqeId` runs.
- **Scenario**: BQE accepts the POST, the response arrives, but the app is killed (OOM, force-quit) before `markEntrySyncedWithBqeId` writes. Next sync re-POSTs the same entry → duplicate in BQE.
- **Likelihood**: low (process kill window is small) but real.
- **Suggested fix**: persist a transactional pending→synced state: write a `bqeId` to LocalTimeEntry *immediately before* the POST, and treat presence-of-bqeId as evidence not to re-POST. Or use BQE's idempotency key header (if it supports one).

### 🟡 D-3: Demo / real-tenant cleanup is asymmetric
- **Where**: `store/useAuthStore.ts:48-74` — `login()` calls `clearDemoData()` before hydrating real BQE rows. ✓
- **Missing**: `loginAsDemo()` (lines 76-92) does **not** clear real-tenant rows. If a user logs into BQE, then later picks Demo, real LocalProject/LocalTimeEntry rows still sit alongside demo rows. The home screen would show a mix.
- **Suggested fix**: clear non-`demo-` rows when entering demo mode, or refuse to enter demo while authenticated.

---

## 7. Accessibility

### 🟠 A-1: Sub-20% accessibilityLabel coverage
- **Counted**: 21 `accessibilityLabel|Role` instances across 9 files vs 118 `Pressable` instances across 22 files
- **Covered**: login button, demo button, FAB, scan capture, PhaseButton, FloatingActionButton, ProjectPickerModal cancel
- **Missing**: ProjectCard, EntryRow, PhaseList rows, picker rows, choice chips in settings, modifier buttons, settings rows, day cells in DaySelector, week navigation arrows in WeekBar
- **Suggested fix**: add `accessibilityRole="button"` and a meaningful `accessibilityLabel` to each tappable row component. Most can derive the label from existing props (`name`, `code`, etc.).

### 🟡 A-2: Touch target sizes
- **PhaseButton iconWrap**: 44×44 ✓ (`PhaseButton.tsx:51`)
- **PhaseList rows**: paddingVertical 12 + line-height ≈ 36–40 — borderline under 44
- **`hitSlop` usage**: only one site (`app/entry/picker.tsx:62` — search clear button)
- **Suggested fix**: bump PhaseList rows to `paddingVertical: 14` (puts them at ~44), add `hitSlop={8}` to small icon-only buttons (close, chevron, etc.).

### 🟢 A-3: Color contrast — likely OK against the new soft palette
- After the recent `#F5F5F7` background + `#FFFFFF` cards refactor, accent green on white meets WCAG AA at 16pt. Untested for 12pt muted text.

---

## 8. Edge Cases

### 🟠 EC-1: AI scanner has no retry on transient failure
- **Where**: `services/ai/scanner.ts:84-105`
- **Issue**: One-shot fetch. If Anthropic returns 5xx, 429, or the network blips during the upload of a base64 photo, the scan fails and the user has to recapture.
- **Suggested fix**: single retry with backoff on 5xx/network errors; surface a clearer "try again" affordance on the review screen.

### 🟡 EC-2: BQE pagination silently returns empty on malformed response
- **Where**: `services/bqe/client.ts:226-238`
- **Issue**: If a BQE endpoint ever changes its envelope shape (`value` → something else), `fetchAllPages` returns `[]` rather than erroring. Sync would silently appear successful with zero rows.
- **Suggested fix**: when `data` is an object but none of `value`/`data`/`items` are arrays, log a warning and throw rather than return empty.

### 🟢 EC-3: Empty / loading states present everywhere checked
- Home screen: 3 distinct empty states (no projects, no recent activity, no entries this day) ✓
- Picker: empty state for no projects + no matches ✓
- Phase selector: loading + not-found states ✓
- Settings: skeletons via "Loading…" string ✓
- Scan review: confidence flags ✓

### 🟢 EC-4: Offline path
- `useEntryStore.submitEntry` correctly queues to local DB when `!isOnline()`; `_layout.tsx:65-89` triggers `processQueue` on connectivity-restored / app-foregrounded events. Works.

---

## Cross-cutting recommendations

If you only do five things, do these:
1. **Stand up the server-side proxy** (S-1, S-2) — this is the only fully-blocking item before non-Studio-G distribution.
2. **Convert the picker to FlatList** (P-1) — the user-felt UX improvement is large.
3. **Break the auth-store / sync require cycles** (T-1, T-2) — every other refactor gets easier afterward.
4. **Add accessibilityLabels to row components** (A-1) — mechanical change, real impact on a11y conformance.
5. **Decide dark mode in or out** (T-7) — currently lying about supporting it.

The remaining items can be batched into a "polish week" or addressed as touched.
