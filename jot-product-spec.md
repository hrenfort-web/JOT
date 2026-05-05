# Jot — Product Specification
## "Jot it. Done."

## AI-Powered Timecard Entry for Architecture & Design Firms

*Version 1.0 — May 2026*
*"RAMP did it for expenses. We're doing it for timesheets."*

---

## 1. Product Vision

Jot is an iOS app that makes timecard entry effortless for architecture and design professionals. It integrates directly with BQE Core (with future support for Deltek, Ajera, Monograph) so that time entries flow seamlessly from staff to accounting — no re-entry, no chasing.

The core insight: architects already track their time — on sticky notes, notebooks, whiteboards, and mental notes. Jot closes the gap between how people naturally capture time and what accounting software needs.

### 1.1 Differentiators

1. **Scan-to-timesheet**: Take a photo of handwritten notes → AI parses → review → submit. Three taps.
2. **Tap, don't type**: Phase selection via large buttons, hour entry via base+increment taps. No dropdowns, no scrolling.
3. **Smart pre-fill**: Learns weekly patterns and pre-populates recurring entries for one-tap confirmation.
4. **PM dashboard**: Real-time visibility into team submission status — who's done, who's short, who needs a nudge.
5. **Built by architects, for architects**: Understands the project → phase → activity hierarchy that generic time tracking tools ignore.

---

## 2. User Roles & Permissions

### 2.1 Staff (Default Role)
- Can view only their own assigned projects
- Can create, edit, and delete their own time entries (unless locked/billed)
- Can submit timecards for approval
- Can use scan-to-timesheet, manual entry, and voice entry
- Receives push notification reminders

### 2.2 Project Manager (PM)
- Everything Staff can do
- Can view time entries for projects they manage (read-only)
- Can see team submission status dashboard for their projects
- Can send nudge reminders to team members on their projects
- Can approve/reject submitted time entries (if firm uses approval workflow)

### 2.3 Admin (Director of Ops / Principal)
- Everything PM can do
- Can view all employees, all projects, all time entries
- Can configure firm-wide settings (reminder schedule, phase display names, default activities)
- Can manage which projects appear as "active" in the app
- Can view firm-wide utilization summary

### 2.4 Permission Model
Permissions inherit from BQE Core. When a user authenticates via OAuth, their BQE security permissions and subscription level determine what data the app can access on their behalf. The app does NOT implement its own permission layer — it respects BQE's existing access controls.

---

## 3. Data Model — BQE Core Mapping

### 3.1 BQE Core Entity Hierarchy

Understanding this hierarchy is critical. In BQE Core for A/E firms:

```
Company
└── Project (e.g., "Smith Residence" — projectId: uuid)
    ├── Phase (sub-project in BQE, e.g., "Smith Residence - SD" — also a projectId: uuid)
    │   └── Activity (e.g., "Design", "Drafting", "Client Meeting" — activityId: uuid)
    └── Phase (e.g., "Smith Residence - DD" — projectId: uuid)
        └── Activity (same activity codes, different phase context)
```

**Key insight**: Phases in BQE Core are implemented as sub-projects (child projects with their own projectId). They are NOT a separate entity type. This means:
- When the app shows "Smith Residence → DD", it's actually resolving to a specific child projectId
- The parent project is the "job" and children are the "phases"
- The API returns all projects flat — the app must reconstruct the hierarchy using parent-child relationships

### 3.2 BQE Core API Endpoints Used

#### Read Operations (on app launch & sync)

| Endpoint | Method | Purpose | When Called |
|----------|--------|---------|-------------|
| `/employee` | GET | Get current user's profile + employee list (for PM view) | Login, periodic sync |
| `/project` | GET | Fetch active projects with parent-child relationships | Login, periodic sync |
| `/activity` | GET | Fetch activity codes (SD, DD, CD, CA, etc.) | Login, periodic sync |
| `/projectassignment` | GET | Determine which projects/activities a user can charge to | Login, periodic sync |
| `/timeentry` | GET | Fetch existing entries for the current week | App open, after submit |

#### Write Operations (on time entry submission)

| Endpoint | Method | Purpose | When Called |
|----------|--------|---------|-------------|
| `/timeentry` | POST | Create a single time entry | Manual single entry |
| `/timeentry/batch` | POST | Create multiple time entries at once | Scan-to-timesheet submit, weekly batch |
| `/timeentry/{id}` | PUT | Update an existing time entry | Edit mode |
| `/timeentry/{id}` | DELETE | Delete a time entry | Swipe-to-delete |

#### The Time Entry Object (What We Write)

When creating a time entry, the minimum required fields are:

```json
{
  "projectId": "uuid",       // The PHASE-level project ID (child project)
  "activityId": "uuid",      // The activity code (Design, Drafting, etc.)
  "resourceId": "uuid",      // The employee's ID (current user)
  "date": "2026-05-05T00:00:00",  // ISO 8601 date
  "actualHours": 6.5,        // Hours as decimal
  "billable": true,          // Billable flag
  "description": "string",   // Optional description
  "memo": "string"           // Optional memo/note
}
```

Fields the API returns that we display but don't set:
- `billRate` — calculated by BQE based on employee + project settings
- `costRate` — calculated by BQE
- `clientHours` — may differ from actualHours if write-up/down applied
- `billStatus` — managed by billing workflow
- `workflow` — submit/approve status array

### 3.3 App-Side Data Model (Local Cache)

The app maintains a lightweight local cache (Core Data or SQLite) for offline support and fast rendering:

```
LocalProject
├── id: UUID (BQE projectId)
├── name: String ("Smith Residence")
├── code: String ("2024-031")
├── clientName: String ("John & Jane Smith")
├── parentId: UUID? (null for top-level, parent projectId for phases)
├── isPhase: Bool
├── phaseCode: String? ("SD", "DD", "CD", "CA")
├── isActive: Bool
├── color: String (hex — assigned locally for UI)
├── sortOrder: Int
└── lastSynced: Date

LocalActivity
├── id: UUID (BQE activityId)
├── name: String ("Design")
├── code: String ("DES")
├── isBillable: Bool
└── isActive: Bool

LocalEmployee
├── id: UUID (BQE resourceId)
├── displayName: String
├── firstName: String
├── lastName: String
├── role: Enum (staff, pm, admin)
└── standardHoursPerWeek: Double (typically 40)

LocalTimeEntry
├── id: UUID? (null if not yet synced to BQE)
├── bqeId: UUID? (BQE's ID once synced)
├── projectId: UUID (phase-level)
├── activityId: UUID
├── resourceId: UUID
├── date: Date
├── hours: Double
├── memo: String?
├── isBillable: Bool
├── syncStatus: Enum (pending, synced, failed, conflict)
├── submissionStatus: Enum (draft, submitted, approved, rejected)
├── source: Enum (manual, scanned, voice, prefilled)
└── createdAt: Date

ScanResult (temporary, not persisted long-term)
├── id: UUID
├── imageData: Data
├── parsedEntries: [ParsedEntry]
├── confidence: Double (0-1)
├── flags: [ScanFlag]
└── createdAt: Date
```

### 3.4 Project-Phase Resolution

This is the trickiest part of the data model. When a user sees "Smith Residence → DD" in the app, the system needs to:

1. Fetch all projects from BQE: `GET /project?where="isActive=true"`
2. Build parent-child tree: match `parentId` to reconstruct hierarchy
3. Display parent projects as "Project" cards
4. Display child projects as "Phase" buttons
5. When writing a time entry, use the CHILD projectId (the phase), not the parent

For the AI scanner, this means the vision model needs the project-phase lookup table to match shorthand like "Smith DD" to the correct phase-level projectId.

---

## 4. Core Flows

### 4.1 Authentication Flow

```
App Launch
→ Check for stored OAuth tokens (Keychain)
  → If valid token exists: refresh if expired, proceed to home
  → If no token: show BQE Core login (OAuth 2.0 web flow)
    → User enters BQE credentials on BQE's hosted login page
    → BQE redirects back with authorization code
    → App exchanges code for access_token + refresh_token
    → Store tokens in iOS Keychain
    → Fetch employee profile, projects, activities (initial sync)
    → Proceed to home
```

OAuth details:
- Register app on BQE Developer Portal (https://api-developer.bqecore.com)
- Redirect URI: `jot://oauth/callback`
- Scopes needed: `read:core readwrite:core openid offline_access`
- Access tokens expire — use refresh_token for silent renewal
- Base URL for API calls comes from the token response `endpoint` field (varies by data center)

### 4.2 Manual Entry Flow (3-Tap)

```
HOME SCREEN (Week View)
├── Week summary bar (M T W Th F S Su) with hours per day
├── Logged vs. Remaining summary pills
├── Active project cards (color dot + name + current phase + hours this week)
└── Tap a project card...

PHASE SCREEN
├── Project name in nav
├── Day selector tabs (M T W Th F — swipeable to change day without going back)
├── Phase buttons in 2-column grid (SD, DD, CD, CA, Meetings, Other)
│   Each button: icon + phase code + full name
│   One tap selects and advances
└── Tap a phase...

HOUR ENTRY SCREEN
├── Project name + phase badge
├── Large hour display (animated on change)
├── Base hour buttons: 1, 2, 3, 4, 5, 6, 7, 8
├── Modifier buttons: -.25, +.25, +.50, Clear
├── Memo field (REQUIRED — placeholder: "What did you work on?")
│   └── Below field: 3-5 tappable memo chips (context-aware suggestions)
│       e.g., [Drawing development] [Client revisions] [Coordination]
│       Tapping a chip fills the memo. Tapping another appends with comma.
├── "Log time" button (disabled until hours > 0 AND memo is filled)
│   → POST to BQE → toast confirmation → back to home
└── Day tabs still visible — can switch days without navigating back
```

### 4.3 Scan-to-Timesheet Flow (The Killer Feature)

```
HOME SCREEN → Tap camera icon (or floating action button)

SCAN SCREEN
├── Camera viewfinder (or tap to select from photo library)
├── "Write it like this" tip card showing suggested format:
│     Mon
│       Smith Res - DD  6.5
│       Oakwood - CD    2
│     Tue
│       Smith Res - DD  4
│       Library - SD    3
├── Snap photo → processing overlay...

PROCESSING (1-3 seconds)
├── Step 1: "Detecting handwriting" (vision model processes image)
├── Step 2: "Matching projects in BQE" (fuzzy match against local project cache)
├── Step 3: "Building your timesheet" (structured JSON → UI)
└── Advance to review...

REVIEW SCREEN
├── Header: "X entries found" + confidence badge (e.g., "96% confident")
├── Entries grouped by day:
│   Each entry row: color dot + project name + phase + hours + edit pencil
│   Flagged entries highlighted in amber with explanation
│   (e.g., "Read as 1.5 — could be 1.5 or 15. Please verify.")
├── Week total bar
├── "Submit to BQE Core" button
│   → POST /timeentry/batch
│   → Toast: "X entries submitted"
│   → Return to home with updated totals
└── Edit pencil on any row → opens inline edit (same hour entry UI)
```

#### 4.3.1 Vision Model Integration

The scan feature sends the photo to a vision-capable AI model (Claude API or similar) with a structured prompt:

**System prompt to vision model:**
```
You are a timesheet parser for an architecture firm. You will receive a photo
of handwritten time notes. Parse the entries and return structured JSON.

The user's active projects are:
{{PROJECT_LOOKUP_TABLE}}

Match shorthand project names to the closest project in the lookup table.
Match phase codes: SD = Schematic Design, DD = Design Development,
CD = Construction Documents, CA = Construction Administration.

Return JSON in this format:
{
  "entries": [
    {
      "day": "monday",
      "project_match": "Smith Residence",
      "project_id": "uuid-from-lookup",
      "phase": "DD",
      "phase_project_id": "uuid-of-phase",
      "hours": 6.5,
      "confidence": 0.98,
      "flag": null
    }
  ],
  "overall_confidence": 0.96,
  "flags": [
    {
      "entry_index": 4,
      "reason": "Ambiguous handwriting: could be 1.5 or 15",
      "suggestion": 1.5
    }
  ]
}
```

**The project lookup table** is built from the local cache and injected into the prompt. Example:
```
| Shorthand | Full Name | Project ID | Phase | Phase ID |
|-----------|-----------|------------|-------|----------|
| Smith, Smith Res | Smith Residence | abc-123 | SD | def-456 |
| Smith, Smith Res | Smith Residence | abc-123 | DD | ghi-789 |
| Oakwood, Oak | Oakwood Mixed-Use | jkl-012 | CD | mno-345 |
```

This lets the model fuzzy-match "Smith" or "Smith R" or "SR" to the right project.

#### 4.3.2 Acceptable Input Formats

The AI should handle all of these gracefully:

- **Structured notes**: Day headers with indented project lines (ideal)
- **Flat lists**: "Mon Smith DD 6, Mon Oakwood CD 2, Tue Smith DD 4"
- **Abbreviated**: "S-DD 6.5" or "Oak CD 2"
- **Mixed handwriting quality**: The model should flag low-confidence reads
- **Whiteboard photos**: Larger format, possibly with grid lines
- **Typed notes**: Screenshot of a Notes app or text message to self

### 4.4 Smart Pre-fill Flow

```
FRIDAY 4PM PUSH NOTIFICATION
"You've logged 24 of 40 hours this week. Tap to fill in the rest."

→ Opens PRE-FILL SCREEN
├── Shows detected patterns from last 4 weeks:
│   "You usually log 8h to Smith Res DD on Mondays"
│   "You usually log 4h to Oakwood CD on Wednesdays"
├── Pre-filled timecard for the empty days
├── Each row is editable (tap to adjust hours, swipe to remove)
├── "Looks good" button → batch submit
└── "Let me edit" → opens full week view with pre-filled data editable
```

Pattern detection logic (runs locally):
1. Look at last 4 weeks of time entries for this user
2. Group by (day_of_week, project, phase)
3. If a combination appears 3+ out of 4 weeks: it's a pattern
4. Use the median hours from those weeks as the pre-fill value
5. Don't pre-fill days that already have entries

### 4.5 Voice Entry Flow (v2 Feature)

```
HOME SCREEN → Tap microphone icon

VOICE SCREEN
├── Large pulsing microphone indicator
├── User speaks: "Monday, 6 and a half hours on Smith Residence DD,
│   2 hours on Oakwood CD. Tuesday, 4 on Smith DD, 3 on Library SD."
├── Transcription appears in real-time
├── On stop: same processing pipeline as scan
│   (transcribed text → AI parse → structured JSON → review screen)
└── Same REVIEW SCREEN as scan flow
```

### 4.6 PM Dashboard Flow

```
PM taps "Team" tab in bottom nav

PM DASHBOARD
├── Week selector (current week default)
├── Summary cards:
│   ├── "8 of 11 submitted" (with progress ring)
│   ├── "Average utilization: 87%"
│   └── "3 need reminders"
├── Team list:
│   Each row: avatar/initials + name + hours logged + status icon
│   Status: ✓ Complete (green) | ⚠ Partial (amber) | ✗ Missing (red)
│   Tap row → see their entries for the week (read-only)
│   Swipe row → "Send reminder" (push notification to that person)
├── Filter: All | My Projects | Needs Attention
└── "Remind All Incomplete" button → batch push notification
```

Data source: `GET /timeentry?where="date>=WEEK_START AND date<=WEEK_END"` with PM's access scope (can see their project team members).

---

## 5. Technical Architecture

### 5.1 Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| iOS App | React Native (Expo) | Cross-platform potential, H's existing experience |
| State Management | Zustand or Redux Toolkit | Lightweight, good for offline sync patterns |
| Local Storage | Expo SQLite or WatermelonDB | Offline-first, handles sync conflicts |
| Authentication | Expo AuthSession + OAuth 2.0 | BQE Core's standard auth flow |
| API Layer | Axios with interceptors | Token refresh, retry logic, rate limiting |
| Vision AI | Claude API (claude-sonnet-4-6) | Best vision + structured output for handwriting |
| Voice | Expo Speech Recognition → Claude API | Transcribe locally, parse via AI |
| Push Notifications | Expo Notifications + APNs | Reminders, PM nudges |
| Backend (v2) | Supabase | User preferences, cross-device sync, analytics |

### 5.2 Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│                    iOS App                       │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐ │
│  │  UI Layer  │  │  Camera  │  │    Voice     │ │
│  │ (React     │  │  Module  │  │   Module     │ │
│  │  Native)   │  │          │  │              │ │
│  └─────┬──────┘  └────┬─────┘  └──────┬───────┘ │
│        │              │               │          │
│  ┌─────▼──────────────▼───────────────▼───────┐ │
│  │              State Manager                  │ │
│  │     (Zustand — projects, entries, user)     │ │
│  └─────┬──────────────┬───────────────┬───────┘ │
│        │              │               │          │
│  ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼───────┐ │
│  │ Local DB   │ │  BQE API   │ │  Claude API │ │
│  │ (SQLite)   │ │  Service   │ │  Service    │ │
│  │ offline    │ │            │ │ (scan/voice)│ │
│  │ cache      │ │            │ │             │ │
│  └────────────┘ └─────┬──────┘ └──────┬──────┘ │
└────────────────────────┼──────────────┼─────────┘
                         │              │
                    ┌────▼────┐   ┌─────▼──────┐
                    │ BQE Core│   │ Anthropic  │
                    │ REST API│   │ Messages   │
                    │         │   │ API        │
                    └─────────┘   └────────────┘
```

### 5.3 Offline-First Strategy

Time entry MUST work without internet. Architects are often on job sites with poor connectivity.

1. **Local cache**: Projects, activities, and employee data sync on app open (when online)
2. **Offline writes**: Time entries save to local DB immediately with `syncStatus: pending`
3. **Background sync**: When connectivity returns, pending entries POST to BQE in batch
4. **Conflict resolution**: If an entry was modified in BQE while offline, show conflict UI:
   - "This entry was modified in BQE Core. Keep yours / Keep theirs / Merge"
5. **Cache TTL**: Project/activity data refreshes every 24 hours or on manual pull-to-refresh

### 5.4 Rate Limiting

BQE Core enforces per-minute rate limits. The app must:
- Batch time entry creation using `/timeentry/batch` (not individual POSTs)
- Respect `429 Too Many Requests` and `Retry-After` header
- Queue requests with exponential backoff
- Show user-friendly message: "BQE is busy — your entries are queued and will submit shortly"

### 5.5 Security

- OAuth tokens stored in iOS Keychain (encrypted at rest)
- No BQE credentials stored in the app — OAuth only
- Scanned images processed via Claude API, NOT stored on any server
- Local DB encrypted using SQLCipher (or Expo SecureStore for sensitive fields)
- API key for Claude stored server-side in v2 (Supabase Edge Function as proxy)
  - MVP: bundled in app with certificate pinning (acceptable for Studio G internal use)

---

## 6. Screen Inventory

### 6.1 Tab Bar (Bottom Navigation)

| Tab | Icon | Screen | Role |
|-----|------|--------|------|
| Home | `ti-home` | Week view + project list | All |
| Scan | `ti-camera` | Scan-to-timesheet | All |
| Team | `ti-users` | PM dashboard | PM, Admin |
| Settings | `ti-settings` | Profile, sync, preferences | All |

### 6.2 Complete Screen List

1. **Onboarding / BQE Login** — OAuth web view
2. **Home — Week View** — Day pills, summary, project cards
3. **Phase Selection** — 2-column button grid for a selected project
4. **Hour Entry** — Base buttons + modifier buttons + memo
5. **Scan — Camera** — Viewfinder + format tip card
6. **Scan — Processing** — Spinner + step indicators
7. **Scan — Review** — Parsed entries grouped by day, edit/confirm
8. **Pre-fill Suggestion** — Pattern-based entries for confirmation
9. **PM Dashboard** — Team submission status, utilization summary
10. **PM — Employee Detail** — Individual's entries for the week (read-only)
11. **Settings — Profile** — Connected BQE account, sync status
12. **Settings — Preferences** — Reminder time, default activity, theme
13. **Settings — Admin** — Active projects, phase display names (Admin only)

---

## 7. Smart Features Detail

### 7.1 Reminder System

| Trigger | Time | Message | Action |
|---------|------|---------|--------|
| Daily incomplete | 5:00 PM | "You've logged X of 8 hours today" | Opens home |
| Weekly warning | Thursday 4 PM | "You have X hours remaining this week" | Opens home |
| Weekly deadline | Friday 4 PM | "Timecards due! You're X hours short" | Opens pre-fill |
| PM nudge | On demand | "[PM name] is reminding you to submit hours" | Opens home |
| Smart nudge | Varies | "Looks like you forgot Tuesday — want to fill it in?" | Opens day view |

Reminders are configurable per user in Settings. Admin can set firm-wide defaults.

### 7.2 Project Matching Intelligence

The fuzzy matching system (used by both scan and voice) ranks matches by:

1. **Exact match** (100%): "Smith Residence" → Smith Residence
2. **Starts with** (90%): "Smith" → Smith Residence
3. **Contains** (80%): "Res" → Smith Residence
4. **Abbreviation** (70%): "SR" → Smith Residence (first letters of each word)
5. **Levenshtein distance** (60%): "Smth Resdence" → Smith Residence
6. **Recent usage boost** (+10%): Projects the user charged to last week rank higher

If the best match confidence is below 70%, the entry is flagged for manual review.

### 7.3 Hours Sanity Checks

Before submitting, the app validates:
- No single entry > 16 hours (flag as likely error)
- Daily total ≤ 24 hours (block submission)
- Weekly total within ±20% of standard hours (warn, don't block)
- No duplicate entries (same project + phase + day, warn)
- No entries on days marked as PTO/holiday in BQE (warn)

### 7.4 Memo Intelligence (Required Field)

Memos are required on every time entry. PMs review them, and clients may question hours, so they must be meaningful — but entry must stay fast. The app uses three strategies to minimize typing:

#### 7.4.1 Tappable Memo Chips

Below the memo text field, show 3-5 tappable suggestion chips. These are context-aware:

**Phase-based defaults** (always available):
- SD: "Concept development", "Site analysis", "Programming", "Client meeting"
- DD: "Drawing development", "Coordination", "Consultant review", "Design revisions"
- CD: "Document production", "Detail development", "Code review", "Spec writing"
- CA: "RFI review", "Submittal review", "Site visit", "Punch list"
- Meetings: "Team coordination", "Client meeting", "Consultant coordination"

**History-based suggestions** (learned):
- Pull the user's 10 most recent memos for this project+phase combination
- Deduplicate and rank by frequency
- Show the top 3 as chips, prioritized over phase defaults
- Example: If someone always writes "Redline review" for CD on Oakwood, that chip appears first

**Combo chips** (tap multiple):
- Tapping a chip appends to the memo field (with comma separator)
- User can tap "Drawing development" then "Client revisions" → memo reads "Drawing development, client revisions"
- This lets people build a memo from parts without typing

#### 7.4.2 AI Memo Suggestions (Scan Flow)

When parsing handwritten notes, the AI can also extract memo context if present:
- "Smith DD 6.5 - coordinating w/ structural" → hours: 6.5, memo: "Coordinating with structural engineer"
- If no memo is written, the AI suggests one based on the phase: "Design development" (editable)

The scan review screen should show the memo field pre-populated (from notes or AI suggestion) but highlighted for review.

#### 7.4.3 Memo Templates

Admin can configure firm-wide memo templates per phase:
- Ensures consistency across staff
- New employees get useful defaults immediately
- Templates appear as the first chips before personal history kicks in

#### 7.4.4 Memo Field UX Details

- Text field is ALWAYS visible (not hidden behind a toggle)
- Placeholder text: "What did you work on?" (not "Add a note")
- Field shows a red indicator if empty when user taps "Log time"
- Minimum length: 3 characters (prevents "." or "x" as memos)
- Maximum length: 100 characters (BQE API limit on description field)
- Tapping a chip populates the field AND moves focus to the submit button
- If memo is pre-filled from a chip, user can still edit before submitting

---

## 8. MVP Scope (v1 — Studio G Internal)

### 8.1 In Scope for v1

- [x] BQE Core OAuth authentication
- [x] Home screen with week view and project cards
- [x] Manual entry flow (project → phase → hours with base+modifier buttons)
- [x] Day tab navigation within entry flow
- [x] Scan-to-timesheet (photo → AI parse → review → batch submit)
- [x] Local caching of projects/activities/employees
- [x] Basic offline support (queue entries for sync)
- [x] Push notification reminders (daily + weekly)
- [x] Hours sanity checks (warn on anomalies)

### 8.2 v2 (After Studio G Validation)

- [ ] PM dashboard with team status
- [ ] PM nudge notifications
- [ ] Smart pre-fill based on weekly patterns
- [ ] Voice entry
- [ ] Supabase backend for cross-device sync + analytics
- [ ] Usage analytics (which features get used, entry completion rates)
- [ ] App Store distribution
- [ ] Multi-firm support (any BQE Core customer can connect)

### 8.3 v3 (Market Expansion)

- [ ] Deltek Vantagepoint integration
- [ ] Ajera integration
- [ ] Monograph integration
- [ ] Android app
- [ ] Web companion (for PM dashboard on desktop)
- [ ] Firm-wide analytics and reporting
- [ ] Calendar integration (auto-suggest entries from meeting data)
- [ ] Apple Watch quick entry

---

## 9. Business Model (Future)

### 9.1 Pricing Tiers

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0 | Manual entry only, 1 user, BQE Core connection |
| Pro | $8/user/month | Scan-to-timesheet, voice entry, smart pre-fill, push reminders |
| Team | $12/user/month | Pro + PM dashboard, team nudges, utilization reporting |
| Enterprise | Custom | Team + SSO, custom integrations, dedicated support |

### 9.2 Go-to-Market

1. **Phase 1**: Build for Studio G (30 users). Validate core flows, measure adoption.
2. **Phase 2**: Offer to 5-10 BQE Core firms in the Bay Area architect network. Free beta.
3. **Phase 3**: Launch on App Store with BQE Core integration. Content marketing via architecture firm management blogs/podcasts.
4. **Phase 4**: Add Deltek/Ajera integrations to capture broader A/E market.

Target market size: ~50,000 BQE Core users (per BQE's own marketing). Even 5% penetration at $8/user/month = $2.4M ARR.

---

## 10. Open Questions & Decisions Needed

1. **App name**: ✅ DECIDED — **Jot**. Tagline: "Jot it. Done." Domain TBD (getjot.com is premium, exploring alternatives like jottime.app, usejot.com, jothq.com).

2. **Phase display**: Should phases show as the BQE project code (e.g., "2024-031-SD") or a friendly name (e.g., "Schematic Design")? Probably configurable per firm.

3. **Activity granularity**: ✅ DECIDED — One default activity per phase. No activity selection step in the UI. Admin configures the default activityId for each phase in Settings. This keeps the entry flow to 3 taps (project → phase → hours) instead of 4. If a firm later needs activity-level granularity, it can be added as an "Advanced" toggle in v2.

4. **Memos**: ✅ DECIDED — Memos are REQUIRED on every entry. PMs review memos and clients may question hours. The app must make memo entry as fast as possible via: (a) smart suggestions based on phase + recent history, (b) tappable memo chips for common descriptions, (c) learning from user's past memos, (d) AI-generated suggestions during scan-to-timesheet. See Section 7.4 for full memo intelligence spec.

5. **Approval workflow**: If the firm uses submit-approve in BQE, does the app handle submission? Or just create entries and let them submit in BQE? **Recommendation**: v1 creates entries as "unsubmitted." v2 adds a "Submit Week" button that triggers the BQE workflow API.

5. **Multi-firm for PMs**: Some PMs consult for multiple firms. Each firm has its own BQE instance. Does the app support switching between BQE accounts? **Recommendation**: v2 feature. v1 is single-firm.

6. **Claude API key management**: For the scan feature, the Claude API key needs to live somewhere. Options:
   - Bundled in app (acceptable for internal v1, not for public release)
   - Supabase Edge Function as proxy (v2, preferred for App Store release)
   - User brings their own key (bad UX, only for power users)

---

## 11. Technical Notes for Claude Code Implementation

### 11.1 Project Structure (React Native / Expo)

```
jot/
├── app/                     # Expo Router screens
│   ├── (tabs)/              # Tab-based navigation
│   │   ├── index.tsx        # Home / Week View
│   │   ├── scan.tsx         # Scan entry point
│   │   └── settings.tsx     # Settings
│   ├── entry/
│   │   ├── [projectId].tsx  # Phase selection
│   │   └── hours.tsx        # Hour entry
│   ├── scan/
│   │   ├── camera.tsx       # Camera view
│   │   ├── processing.tsx   # AI processing
│   │   └── review.tsx       # Review & submit
│   └── auth/
│       └── login.tsx        # OAuth flow
├── components/
│   ├── WeekBar.tsx          # Day pills with hours
│   ├── ProjectCard.tsx      # Project list item
│   ├── PhaseButton.tsx      # Phase selection button
│   ├── HourPicker.tsx       # Base + modifier hour entry
│   ├── EntryRow.tsx         # Time entry row (review screen)
│   └── SummaryPill.tsx      # Logged/Remaining pill
├── services/
│   ├── bqe/
│   │   ├── auth.ts          # OAuth 2.0 flow
│   │   ├── client.ts        # Axios instance with token refresh
│   │   ├── timeentry.ts     # Time entry CRUD
│   │   ├── project.ts       # Project fetch + hierarchy builder
│   │   ├── activity.ts      # Activity fetch
│   │   └── employee.ts      # Employee fetch
│   ├── ai/
│   │   ├── scanner.ts       # Vision model integration
│   │   ├── parser.ts        # Parse AI response → structured entries
│   │   └── matcher.ts       # Fuzzy project name matching
│   └── sync/
│       ├── queue.ts         # Offline entry queue
│       └── resolver.ts      # Conflict resolution
├── store/
│   ├── useProjectStore.ts   # Project + phase state
│   ├── useEntryStore.ts     # Time entry state
│   ├── useAuthStore.ts      # Auth tokens + user profile
│   └── useSyncStore.ts      # Sync status
├── db/
│   └── schema.ts            # SQLite schema for local cache
└── utils/
    ├── dateHelpers.ts       # Week calculations, ISO formatting
    ├── hourMath.ts          # Safe decimal hour arithmetic
    └── constants.ts         # Phase codes, colors, etc.
```

### 11.2 Key Implementation Notes

1. **BQE base URL is dynamic**: The `endpoint` field from the OAuth token response is the base URL. It varies by BQE data center. Store it alongside the token.

2. **Project hierarchy reconstruction**: `GET /project` returns a flat list. Filter by `isActive=true`, then build tree by matching `parentId` fields. Top-level projects have `parentId: null`.

3. **Time zones**: BQE defaults to Pacific Time. Include `X-UTC-OFFSET` header with the user's local offset in minutes. Critical for correct date assignment.

4. **Token refresh**: Access tokens expire. Use `refresh_token` with `grant_type=refresh_token` to get new access tokens silently. If refresh fails, redirect to login.

5. **Batch entry response**: The `/timeentry/batch` endpoint returns a Job object, not the entries. Poll the job endpoint to check completion status before confirming to user.

6. **Decimal hours**: BQE uses decimal hours (6.5 = 6 hours 30 minutes). The app should always work in decimal, never HH:MM format. Use safe floating point: `Math.round(value * 4) / 4` to snap to nearest quarter hour.

---

*End of specification. This document should be provided as context when initiating Claude Code sessions for building Jot.*
