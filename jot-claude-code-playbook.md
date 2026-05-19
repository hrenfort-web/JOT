# Jot — Claude Code Build Playbook
## How to Build This App Module-by-Module with Claude Code

*This document is your build sequence. Each section is a Claude Code session with the prompt to use. Go in order — each module builds on the last.*

---

## Before You Start

### Prerequisites
1. Install Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
2. Install Expo CLI (`npm install -g expo-cli`)
3. Create a BQE Developer Portal account (https://api-developer.bqecore.com)
4. Register your app on BQE Developer Portal and get your Client ID + Client Secret
5. Have the product spec (`timecard-app-spec.md`) in your project root

### How to Use This Document
- Each "SESSION" below is one Claude Code session
- Start each session by referencing the spec: "Read timecard-app-spec.md for full context"
- The prompts are written to be copy-pasted into Claude Code
- After each session, TEST the output before moving to the next
- If something doesn't work, don't start a new session — fix it in the current one
- Commit after each working session

### Project Init (Do This Yourself First)
```bash
npx create-expo-app jot --template expo-template-blank-typescript
cd jot
npx expo install expo-router expo-auth-session expo-secure-store expo-camera expo-sqlite
npm install zustand axios
```

---

## Phase 1: Foundation (Sessions 1-4)

### SESSION 1 — Project Structure & Navigation Shell

**Goal**: Get the app skeleton running with tab navigation and placeholder screens.

**Prompt**:
```
Read timecard-app-spec.md for full product context.

Set up the Expo Router file-based navigation structure for Jot, a timecard app.

Create the tab bar with 3 tabs:
1. Home (ti-home icon) — placeholder text "Week View"
2. Scan (ti-camera icon) — placeholder text "Scan Timesheet" 
3. Settings (ti-settings icon) — placeholder text "Settings"

Also create these stack screens (not in tabs):
- app/entry/[projectId].tsx — Phase selection (placeholder)
- app/entry/hours.tsx — Hour entry (placeholder)
- app/scan-processing.tsx — placeholder
- app/scan-review.tsx — placeholder  
- app/auth/login.tsx — placeholder

Use a clean, minimal design system:
- Background: white
- Accent color: #1D9E75 (green)
- Font: system default
- Tab bar: standard iOS style with labels

Make sure the app runs with `npx expo start` and all navigation routes work.
Do NOT build any features yet — just the navigation shell with placeholder content on each screen.
```

**Verify**: App launches, all tabs work, can navigate to entry and scan screens.

---

### SESSION 2 — BQE Core Authentication

**Goal**: Working OAuth 2.0 login flow with BQE Core.

**Prompt**:
```
Read timecard-app-spec.md, specifically sections 4.1 (Authentication Flow) and 5.1-5.5 (Technical Architecture).

Build the BQE Core OAuth 2.0 authentication flow for Jot.

Requirements:
1. Create services/bqe/auth.ts:
   - OAuth 2.0 authorization code flow using expo-auth-session
   - Redirect URI: jot://oauth/callback
   - Scopes: read:core readwrite:core openid offline_access
   - Exchange auth code for access_token + refresh_token
   - Store tokens securely in expo-secure-store
   - Token refresh function (silent refresh when access token expires)

2. Create services/bqe/client.ts:
   - Axios instance with base URL from token response `endpoint` field
   - Request interceptor that adds Authorization: Bearer header
   - Response interceptor that handles 401 (trigger token refresh) and 429 (respect Retry-After)
   - Include X-UTC-OFFSET header with device timezone offset

3. Create store/useAuthStore.ts (Zustand):
   - State: isAuthenticated, user (employee profile), tokens, baseUrl
   - Actions: login, logout, refreshToken, loadStoredTokens
   
4. Update app/auth/login.tsx:
   - "Connect to BQE Core" button that initiates OAuth flow
   - Loading state during token exchange
   - Error handling with user-friendly messages
   - On success: fetch employee profile via GET /employee (filter to current user using the openid token's sub claim), save to store, navigate to home

5. Update app root layout:
   - Check for stored tokens on app launch
   - If valid tokens exist: show tabs
   - If no tokens: show login screen
   - Handle token expiry gracefully

For now, use placeholder environment variables for Client ID and Client Secret.
The BQE authorize endpoint is: https://api-login.bqe.com/authorize
The token endpoint is: https://api-login.bqe.com/token
```

**Verify**: Can tap login, see BQE's OAuth page, authenticate, and return to the app. Token persists across app restarts.

---

### SESSION 3 — Data Layer (BQE Sync + Local Cache)

**Goal**: Fetch projects, activities, and employees from BQE and cache locally.

**Prompt**:
```
Read timecard-app-spec.md, specifically section 3 (Data Model) — pay close attention to section 3.4 about project-phase resolution.

Build the data sync layer that fetches from BQE Core and caches locally.

Requirements:

1. Create db/schema.ts using expo-sqlite:
   - LocalProject table: id, name, code, clientName, parentId (nullable), isPhase, phaseCode, isActive, color, sortOrder, lastSynced
   - LocalActivity table: id, name, code, isBillable, isActive
   - LocalEmployee table: id, displayName, firstName, lastName, role, standardHoursPerWeek
   - LocalTimeEntry table: id, bqeId (nullable), projectId, activityId, resourceId, date, hours, memo, isBillable, syncStatus (pending/synced/failed), source (manual/scanned/voice/prefilled), createdAt
   - Create db/database.ts with init, query, and upsert helpers

2. Create services/bqe/project.ts:
   - fetchProjects(): GET /project?where="isActive=true"&fields=id,name,code,parentId,client&page=1,1000
   - buildProjectHierarchy(): Takes flat project list, reconstructs parent-child tree
     CRITICAL: Phases in BQE are child projects. parentId != null means it's a phase.
     Extract phase code from project name or code (common patterns: "ProjectName - SD", or code like "2024-031-SD")
   - Save to LocalProject table
   - Assign colors to top-level projects (cycle through a preset palette)

3. Create services/bqe/activity.ts:
   - fetchActivities(): GET /activity?where="isActive=true"&fields=id,name,code,billable
   - Save to LocalActivity table

4. Create services/bqe/employee.ts:
   - fetchEmployees(): GET /employee?fields=id,displayName,firstName,lastName,billRate,costRate,status
   - Save to LocalEmployee table

5. Create services/bqe/timeentry.ts:
   - fetchWeekEntries(resourceId, weekStart, weekEnd): GET /timeentry?where="resourceId={id} AND date>={start} AND date<={end}"
   - createEntry(entry): POST /timeentry with required fields (projectId, activityId, resourceId, date, actualHours, description, billable)
   - createBatchEntries(entries): POST /timeentry/batch
   - Save fetched entries to LocalTimeEntry table with syncStatus='synced'

6. Create services/sync/initialSync.ts:
   - Runs after login: fetches projects, activities, employees in parallel
   - Shows progress indicator
   - Stores lastSyncTime in SecureStore
   
7. Create store/useProjectStore.ts (Zustand):
   - State: projects (tree structure), activities, isLoading
   - Computed: getProjectPhases(parentId), getActiveProjects(), getUserProjects(resourceId)
   
8. Create store/useEntryStore.ts (Zustand):
   - State: weekEntries, selectedDate, pendingEntries
   - Actions: addEntry, updateEntry, deleteEntry, syncPendingEntries

Important: when creating a time entry, use the PHASE-level projectId (the child), not the parent project ID. The activityId should use a default activity — for now, use the first billable activity in the activity list.

Use the BQE API client from Session 2.
```

**Verify**: After login, projects/activities/employees sync. Check SQLite DB has data. Projects display in correct hierarchy (parent → phases).

---

### SESSION 4 — Home Screen (Week View)

**Goal**: The main screen showing the week at a glance with project cards.

**Prompt**:
```
Read timecard-app-spec.md, specifically sections 4.2 (Manual Entry Flow) for the home screen layout.

Build the Home screen (Week View) for Jot.

Requirements:

1. Week bar at top:
   - Shows M T W Th F (optionally S Su based on firm settings)
   - Each day shows abbreviated name + hours logged that day
   - Current day is highlighted with accent color (#1D9E75)
   - Days with 0 hours show "—" in muted color
   - Tapping a day updates the selectedDate in the entry store

2. Summary section:
   - Two pill-shaped cards side by side
   - Left: "Logged" with total hours for the week
   - Right: "Remaining" with (40 - logged) hours
   - 40 is the default, but should read from employee.standardHoursPerWeek

3. Project cards list:
   - Section header: "Your projects"
   - Each card shows: color dot, project name, current phase name, hours logged this week
   - Only show projects the user has time entries for this week OR is assigned to (from project assignments)
   - Cards sorted by: projects with hours this week first, then alphabetical
   - Tapping a card navigates to app/entry/[projectId].tsx

4. Floating action button (bottom right):
   - Camera icon
   - Tapping navigates to the scan flow (app/(tabs)/scan.tsx for now)

5. Pull-to-refresh:
   - Triggers a fresh sync of time entries for the current week

6. Empty state:
   - If no projects: "No active projects found. Make sure you're assigned to projects in BQE Core."

Data source: Read from local SQLite cache (populated in Session 3). 
Week calculation: Monday through Sunday, based on device locale.

Use the project hierarchy from useProjectStore — display parent project names on the cards, with the most recent phase shown as subtitle.

Style: Clean, white background, minimal borders, system fonts. Match the mockups in the spec (rounded cards, color dots, chevron arrows).
```

**Verify**: Home screen shows real data from BQE. Week bar reflects actual time entries. Tapping a project card navigates to phase selection.

---

## Phase 2: Core Entry Flow (Sessions 5-7)

### SESSION 5 — Phase Selection Screen

**Prompt**:
```
Read timecard-app-spec.md section 4.2 — the Phase Selection screen.

Build the phase selection screen at app/entry/[projectId].tsx.

Requirements:

1. Nav bar: back arrow + project name
2. Day selector tabs below nav (M T W Th F) — shows which day they're logging for, tappable to switch days without going back
3. Phase buttons in a 2-column grid:
   - Each button: relevant icon + phase code (SD, DD, CD, CA) + full phase name below
   - Icons: SD=pencil, DD=ruler, CD=file-text, CA=building, Meetings=users, Other=dots
   - Tapping a phase button immediately navigates to the hours screen
   - Pass the selected phase's projectId (the child project ID) to the hours screen

4. Only show phases that exist as child projects in BQE for this parent project
5. If only one phase exists, skip this screen and go directly to hours

The phase buttons should be large (easy to tap), with no confirmation step. One tap and advance.
```

**Verify**: Tapping a project from home shows its phases. Tapping a phase goes to hour entry.

---

### SESSION 6 — Hour Entry Screen (with Memo Chips)

**Prompt**:
```
Read timecard-app-spec.md sections 4.2 (Hour Entry screen) and 7.4 (Memo Intelligence).

Build the hour entry screen at app/entry/hours.tsx. This is the core of the app — it needs to feel fast and satisfying.

Requirements:

1. Header: project name + phase badge (colored pill showing phase code)
2. Day tabs (same as phase screen — can switch days without going back)
3. Large hour display: big number centered, animates (subtle scale bounce) on change
4. Base hour buttons: 1 through 8 in a 4-column grid
   - Tapping a base number SETS the hours to that value
   - The selected base button stays highlighted
5. Modifier row below: four buttons
   - "- .25" (decrements by 0.25, min 0)
   - "+ .25" (increments by 0.25)  
   - "+ .50" (increments by 0.50)
   - "Clear" (resets to 0)
   - These MODIFY the current value (e.g., tap 6, then +.50 = 6.5)
   
6. Memo section (REQUIRED):
   - Label: "What did you work on?" with "required" badge in red
   - Text input with placeholder "Tap a suggestion or type..."
   - Character counter (X/100) appears when typing
   - Red border if user tries to submit with empty memo
   - Green border when memo has 3+ characters
   
7. Memo suggestion chips below the input:
   - Show 5 tappable pill-shaped chips
   - First priority: user's recent memos for this project+phase (query LocalTimeEntry for last 30 days, same projectId, deduplicate memo text, rank by frequency)
   - Second priority: phase-based defaults:
     SD: "Concept development", "Site analysis", "Programming", "Client meeting"
     DD: "Drawing development", "Coordination", "Consultant review", "Design revisions"  
     CD: "Document production", "Detail development", "Code review", "Spec writing"
     CA: "RFI review", "Submittal review", "Site visit", "Punch list"
   - Label above chips: "Your recent memos" (if history exists) or "Suggested for [phase]"
   - Tapping a chip FILLS the memo (or APPENDS with ", " if memo already has text)
   - Tapped chips get a highlighted state

8. Submit button: "Log time"
   - DISABLED (grayed out) until hours > 0 AND memo >= 3 characters
   - On tap: create time entry via POST /timeentry
     - projectId = the phase-level child project ID
     - activityId = default activity for the firm (first billable activity from cache)
     - resourceId = current user's employee ID
     - date = selected date in ISO format
     - actualHours = the entered hours
     - description = the memo text
     - billable = true (default)
   - On success: show green toast "[X]h logged — [memo preview]", navigate back to home
   - On failure: show error toast, keep the entry in local DB with syncStatus='pending'

9. Haptic feedback: light impact on hour button taps, medium on submit

All decimal math must use Math.round(value * 4) / 4 to snap to quarter hours and avoid floating point issues.
```

**Verify**: Full manual entry flow works end-to-end. Can enter hours, pick a memo chip, submit, see entry appear on home screen.

---

### SESSION 7 — Edit & Delete Existing Entries

**Prompt**:
```
Read the time entry data model from timecard-app-spec.md section 3.

Add the ability to view, edit, and delete existing time entries.

Requirements:

1. On the Home screen, add a "Today's entries" section below the project cards:
   - Shows time entries for the currently selected day
   - Each entry row: color dot, project name, phase, hours, memo preview (truncated), edit icon
   - Tapping an entry opens the hour entry screen pre-populated with that entry's data
   - Swipe left on an entry to reveal a red "Delete" button

2. Edit mode on hours.tsx:
   - When editing an existing entry, pre-fill hours, memo, and highlight the matching base button
   - Change submit button text to "Update entry"
   - On submit: PUT /timeentry/{id} with updated fields (include token and version for concurrency)
   - Show toast "Entry updated"

3. Delete:
   - Swipe-to-delete with confirmation ("Delete 6.5h on Smith Residence?")
   - DELETE /timeentry/{id}
   - Remove from local cache
   - Update home screen totals

4. Handle locked entries:
   - If billStatus indicates billed or locked, show a lock icon and prevent edit/delete
   - Show explanation: "This entry is locked because it has been billed"
```

**Verify**: Can view today's entries, edit an existing entry, delete one. Locked entries can't be modified.

---

## Phase 3: The Killer Feature — Scan to Timesheet (Sessions 8-10)

### SESSION 8 — Camera & Image Capture

**Prompt**:
```
Build the camera/image capture screen for Jot's scan-to-timesheet feature.

Screen: app/(tabs)/scan.tsx (the scan tab)

Requirements:

1. Camera viewfinder area:
   - Uses expo-camera for live preview
   - Large capture button at bottom center
   - "Photo library" button to pick from camera roll (expo-image-picker)
   - Flash toggle button (top right)

2. Below the viewfinder, show a collapsible tip card:
   - Title: "Write it like this" with lightbulb icon
   - Shows example format in monospace:
     Mon
       Smith Res - DD  6.5  struct coord
       Oakwood - CD    2    document production
     Tue  
       Smith Res - DD  4    client revisions
   - Subtitle: "Project + phase + hours + what you worked on. We'll match to BQE."
   - Can collapse/expand. Remember preference in local storage.

3. On capture:
   - Take photo or select from library
   - Compress image to reasonable size (max 1MB) for API transmission
   - Convert to base64
   - Navigate to app/scan-processing.tsx, passing the base64 image data

4. Permissions:
   - Request camera permission on first use
   - If denied, show message with link to Settings
   - Photo library doesn't need camera permission, so offer it as fallback
```

**Verify**: Can open camera, take a photo, select from library. Image is captured and passed to processing screen.

---

### SESSION 9 — AI Parsing (Vision Model Integration)

**Prompt**:
```
Read timecard-app-spec.md section 4.3 (Scan-to-Timesheet Flow), especially 4.3.1 (Vision Model Integration) and 4.3.2 (Acceptable Input Formats).

Build the AI parsing service and processing screen.

Requirements:

1. Create services/ai/scanner.ts:
   - Function: parseTimesheetImage(base64Image: string, projectLookup: ProjectLookupEntry[])
   - Calls the Anthropic Messages API (claude-sonnet-4-6):
     POST https://api.anthropic.com/v1/messages
     - Send image as base64 with type "image" 
     - System prompt should include:
       a. Role: "You are a timesheet parser for an architecture firm"
       b. The project lookup table (built from local cache): project name, shortcuts, phase codes, projectIds
       c. Phase code definitions: SD, DD, CD, CA, Meetings
       d. Output format: strict JSON with entries array, each having: day, projectName, projectId, phaseCode, phaseProjectId, hours, memo (if written), confidence (0-1)
       e. Overall confidence score
       f. Flags array for ambiguous reads (with entry index, reason, suggestion)
       g. Instruction to extract memo/description if the user wrote what they worked on alongside their hours
       h. Instruction to suggest a memo based on phase if no memo is written
     - Parse the response, extract the JSON from the text content
   - Returns: ParsedTimesheet object

2. Create services/ai/matcher.ts:
   - Function: buildProjectLookup(projects: LocalProject[]): ProjectLookupEntry[]
   - Builds the lookup table injected into the AI prompt
   - For each parent project, includes: full name, common abbreviations (first letters of each word, first word, etc.), all phase children with their codes and IDs
   - This is what lets the AI match "Smith DD" to the correct phase projectId

3. Processing screen (app/scan-processing.tsx):
   - Receives base64 image from camera screen
   - Shows a clean loading UI with animated spinner
   - Step indicators that update as processing happens:
     Step 1: "Reading your notes..."
     Step 2: "Matching projects..."  
     Step 3: "Building your timesheet..."
   - Calls parseTimesheetImage() 
   - On success: navigate to review screen with parsed data
   - On error: show error with "Try again" and "Enter manually" options
   - Timeout: 30 seconds max, then show error

4. For API key management in v1 (Studio G internal):
   - Store the Anthropic API key in a .env file (EXPO_PUBLIC_ANTHROPIC_API_KEY)
   - Access via process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY
   - Note in comments: "v2: move to server-side proxy via Supabase Edge Function"

5. Handle edge cases:
   - Blurry image: if AI returns overall confidence < 50%, show "Image too blurry — try again"
   - No entries found: "Couldn't find any time entries in this image"
   - Partial parse: show what was found, let user add missing entries manually
```

**Verify**: Take a photo of handwritten time notes. AI parses them. Processing screen shows steps. Data reaches review screen.

---

### SESSION 10 — Review & Submit Screen

**Prompt**:
```
Read timecard-app-spec.md section 4.3 — the Review screen after AI parsing.

Build the scan review screen at app/scan-review.tsx.

Requirements:

1. Header: "Review & submit" with back arrow
2. Summary bar: "X entries found" + confidence badge (green if >90%, amber if 70-90%, red if <70%)

3. Entries grouped by day:
   - Day header with calendar icon (e.g., "Monday", "Tuesday")
   - Under each day, entry rows:
     - Color dot (matches project color from cache)
     - Project name + phase name
     - Hours (right-aligned, large)
     - Memo text (below project name, smaller, muted — pre-filled from AI parse or AI suggestion)
     - Edit pencil icon on each row
   - Flagged entries: highlighted with amber background + warning icon
     - Show flag reason below: e.g., "Read as 1.5 — could be 1.5 or 15"
     - Tapping a flagged entry opens inline edit

4. Inline editing (when user taps edit pencil or a flagged entry):
   - Entry row expands to show:
     - Project dropdown (pre-selected, can change)
     - Phase buttons (pre-selected, can change)  
     - Hour picker (base + modifier buttons, same as manual entry)
     - Memo field with chips (same as manual entry)
     - "Save" and "Remove" buttons
   - Editing collapses the row back to normal display

5. "Add entry" button at bottom of each day group:
   - Opens a blank inline entry form for that day
   - For entries the AI missed

6. Week total bar:
   - Shows "Week total (X of 5 days)" + total hours
   - Warn if total seems off (>50 or <30)

7. Submit button: "Submit to BQE Core"
   - Validates: all entries have memos (>=3 chars), no unresolved flags
   - If validation fails: scroll to first problem, highlight it
   - On submit: POST /timeentry/batch with all entries
   - Show progress: "Submitting X entries..."
   - On success: toast "X entries submitted", navigate to home
   - On partial failure: show which entries failed, offer retry

8. Each entry maps to a BQE time entry:
   - projectId = phase-level projectId from AI match
   - activityId = firm default activity
   - resourceId = current user
   - date = the day from the parsed result
   - actualHours = hours
   - description = memo text
   - billable = true
```

**Verify**: Full scan flow works end-to-end. Photo → parse → review → edit if needed → submit → entries appear in BQE Core.

---

## Phase 4: Polish & Smart Features (Sessions 11-13)

### SESSION 11 — Offline Support & Sync Queue

**Prompt**:
```
Read timecard-app-spec.md section 5.3 (Offline-First Strategy).

Add offline support so time entry works without internet.

Requirements:

1. Create services/sync/queue.ts:
   - Pending entry queue in SQLite (LocalTimeEntry with syncStatus='pending')
   - When online: process queue in order, POST each to BQE
   - On success: update syncStatus to 'synced', store bqeId
   - On failure: increment retry count, mark as 'failed' after 3 retries
   - On 429 rate limit: pause queue, respect Retry-After header

2. Create services/sync/connectivity.ts:
   - Monitor network state using expo-network
   - When connectivity returns: trigger queue processing
   - When offline: show subtle banner at top of home screen "Offline — entries will sync when connected"

3. Update the entry submission flow:
   - Always save to local DB first (instant feedback to user)
   - Try to POST to BQE immediately
   - If offline: save with syncStatus='pending', show toast "Saved locally — will sync when online"
   - Home screen should show pending entries with a subtle "syncing" indicator

4. Sync status indicators:
   - Entry rows on home screen show: ✓ synced (green), ↻ pending (amber), ✗ failed (red)
   - Tapping a failed entry shows error details and "Retry" option

5. Background sync:
   - When app comes to foreground: check for pending entries, try to sync
   - When network state changes to online: trigger sync
```

**Verify**: Turn off wifi, log entries, verify they save locally, turn wifi back on, verify they sync to BQE.

---

### SESSION 12 — Push Notification Reminders

**Prompt**:
```
Read timecard-app-spec.md section 7.1 (Reminder System).

Add push notification reminders for timecard completion.

Requirements:

1. Use expo-notifications for local notifications (no server needed for v1)

2. Schedule these recurring notifications:
   - Daily (Mon-Fri) at 5:00 PM: "You've logged X of 8 hours today"
     - Only fires if hours < 6 for the day
   - Thursday at 4:00 PM: "You have X hours remaining this week"
     - Only fires if weekly total < 32
   - Friday at 4:00 PM: "Timecards due! You're X hours short"
     - Only fires if weekly total < 38

3. Notification behavior:
   - Tapping a notification opens the app to the home screen
   - Badge count on app icon = number of days with <6 hours this week

4. Settings screen (app/(tabs)/settings.tsx):
   - Toggle reminders on/off
   - Set reminder time (default 5:00 PM)
   - Set target hours per day (default 8)
   - Set target hours per week (default 40)
   - All preferences stored in expo-secure-store

5. Request notification permissions on first app launch (after login)
```

**Verify**: Set a reminder for 1 minute from now, verify it fires with correct hour count.

---

### SESSION 13 — Settings & Profile Screen

**Prompt**:
```
Build the Settings screen at app/(tabs)/settings.tsx.

Requirements:

1. Profile section:
   - Employee name + role from BQE
   - Connected BQE account indicator (green dot + "Connected")
   - "Disconnect" button (clears tokens, returns to login)

2. Sync section:
   - Last synced timestamp
   - "Sync Now" button — triggers full refresh of projects/activities/entries
   - Pending entries count (if any)
   - Cache size

3. Reminders section (from Session 12):
   - Master toggle
   - Reminder time picker
   - Target hours (day/week)

4. Memo section:
   - "Manage memo suggestions" — shows list of firm default memos per phase
   - Admin only: ability to add/edit/remove defaults
   - For non-admins: read-only view

5. About section:
   - App version
   - "Send Feedback" (mailto link)
   - Privacy policy link
   - "Built by Jot" with heart icon

Style: Standard iOS settings layout with grouped sections and subtle headers.
```

---

## Phase 5: Testing & Launch Prep (Sessions 14-15)

### SESSION 14 — Error Handling & Edge Cases

**Prompt**:
```
Review the entire Jot app codebase and add comprehensive error handling.

Focus areas:

1. Network errors:
   - Every BQE API call should have try/catch with user-friendly error messages
   - Timeout after 15s on any API call
   - Retry logic: 1 automatic retry on 5xx errors, then show error to user

2. Auth errors:
   - 401 → attempt token refresh → if refresh fails → redirect to login with message "Your session expired — please log in again"
   - Invalid/revoked tokens → clear stored tokens, redirect to login

3. Data validation:
   - Hours: must be > 0, <= 24 per entry, <= 24 per day total
   - Memo: must be 3-100 characters
   - Date: must not be in the future, must not be more than 30 days in the past (BQE may lock old periods)
   - Project/phase: must exist in local cache (if not found, trigger sync)

4. Camera/scan errors:
   - Camera permission denied → helpful message with Settings link
   - Blurry/unreadable image → "We couldn't read this image clearly. Try taking another photo with better lighting."
   - AI API timeout → "Processing took too long. Try again or enter manually."
   - AI API error → "Something went wrong. Try again or enter manually." with manual entry button

5. Crash prevention:
   - Wrap all screen renders in error boundaries
   - Log errors to console (v2: send to error reporting service)
   - Never show raw error messages to users

6. Empty states for every list:
   - No projects: guidance to check BQE assignments
   - No entries this week: encouraging message + "Start logging" CTA
   - No memo suggestions: show phase defaults only
```

---

### SESSION 15 — Visual Polish & App Store Prep

**Prompt**:
```
Polish the Jot app UI for production quality. This is an internal tool for ~30 people at an architecture firm, but it should feel professional and delightful.

Requirements:

1. App icon:
   - Create a simple app icon: green (#1D9E75) background with a white pen/checkmark mark
   - Use expo's icon configuration

2. Splash screen:
   - Green background with "Jot" wordmark in white
   - Configure in app.json

3. Animation polish:
   - Hour display: scale bounce on change (spring animation)
   - Toast notifications: slide up + fade in
   - Screen transitions: horizontal slide (default Expo Router)
   - Pull-to-refresh: standard iOS
   - Chip tap: subtle background color transition

4. Typography:
   - Consistent sizing: 
     Headers 18px/500
     Body 14px/400
     Captions 12px/400
     Large numbers 48px/500
   - Use system font throughout

5. Color system:
   - Primary: #1D9E75 (green — submit, success, active states)
   - Danger: #E24B4A (red — errors, delete, required indicators)
   - Warning: #EF9F27 (amber — flags, partial states)
   - Info: #378ADD (blue — informational badges)
   - Text primary: system default
   - Text secondary: muted gray
   - Background: white + very light gray for sections

6. Haptic feedback (expo-haptics):
   - Light: hour button tap, chip tap
   - Medium: submit/log time
   - Success: toast confirmation

7. Dark mode support:
   - Use React Native's useColorScheme
   - Dark backgrounds, light text, slightly desaturated accent colors
   - Ensure all text meets WCAG AA contrast ratios

8. TestFlight configuration:
   - Update app.json with proper bundle identifier (com.getjot.app)
   - Configure EAS Build for iOS
   - Set up TestFlight distribution for Studio G team
```

---

## Quick Reference: Session Dependencies

```
Session 1  (Navigation) ─────────────────────────────────┐
Session 2  (Auth) ← needs Session 1                      │
Session 3  (Data Layer) ← needs Session 2                │
Session 4  (Home Screen) ← needs Session 3               │
Session 5  (Phase Selection) ← needs Session 4           │
Session 6  (Hour Entry + Memo) ← needs Session 5         ├── All must
Session 7  (Edit/Delete) ← needs Session 6               │   be done
Session 8  (Camera) ← needs Session 1                    │   in order
Session 9  (AI Parsing) ← needs Session 3, 8             │
Session 10 (Review & Submit) ← needs Session 6, 9        │
Session 11 (Offline) ← needs Session 6                   │
Session 12 (Reminders) ← needs Session 4                 │
Session 13 (Settings) ← needs Session 2, 12              │
Session 14 (Error Handling) ← needs all above             │
Session 15 (Polish) ← needs all above                    ┘
```

## Tips for Working with Claude Code

1. **Start each session with context**: Always open with "Read timecard-app-spec.md" so Claude Code has the full picture.

2. **One module at a time**: Don't try to build everything in one session. The sessions above are scoped to be completable in one sitting.

3. **Test before moving on**: Each session has a "Verify" step. Don't start the next session until the current one works.

4. **When things break**: Say "The [X] screen crashes when I [Y]. Here's the error: [Z]. Fix it." Be specific about the error.

5. **When you want changes**: Be specific. "Make the hour buttons bigger" is better than "improve the UI."

6. **Keep the spec updated**: If you make a design decision during building that changes the spec, update the spec file so future sessions have accurate context.

7. **Commit frequently**: After each working session, commit with a message like "Session 6: Hour entry with memo chips working"

8. **The spec is your source of truth**: If Claude Code suggests something that contradicts the spec, the spec wins. Say "The spec says [X], follow the spec."
