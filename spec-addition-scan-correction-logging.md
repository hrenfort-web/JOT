# Spec Addition: Scan Correction Logging

> Add to jot-product-spec.md as Section 7.5
> Add the ScanCorrection table to Section 3.3 (App-Side Data Model)
> Add logging requirements to Session 10 in the build playbook

---

## 7.5 Scan Correction Logging (Learning Flywheel)

Every scan-to-timesheet interaction is a learning opportunity. The app silently tracks what the AI got right and wrong so the parsing pipeline improves over time.

### 7.5.1 How It Works

1. When the AI returns parsed results, the app stores the full original parse as a snapshot (`ScanResult.originalEntries`)
2. The user reviews and edits entries on the review screen (changing projects, phases, hours, memos)
3. When the user taps "Submit to BQE Core", the app diffs each submitted entry against its original parsed version
4. Any field that changed gets logged as a `ScanCorrection` record
5. Corrections are stored locally and synced to Supabase in v2

### 7.5.2 What Gets Logged

Per correction:

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Correction record ID |
| scanResultId | UUID | Links to the parent ScanResult |
| entryIndex | Int | Which entry in the parsed array (0-indexed) |
| fieldName | Enum | `project`, `phase`, `hours`, `memo` |
| aiValue | String | What the AI returned (e.g., "Smith Residence") |
| aiConfidence | Float | The AI's confidence score for this entry (0-1) |
| userValue | String | What the user changed it to (e.g., "Oakwood Mixed-Use") |
| correctionType | Enum | `wrong_match`, `wrong_hours`, `wrong_phase`, `wrong_memo`, `added_entry`, `removed_entry` |
| createdAt | Date | Timestamp of submission |

Additionally, per scan session:

| Field | Type | Description |
|-------|------|-------------|
| scanResultId | UUID | The scan session |
| totalEntriesParsed | Int | How many entries the AI found |
| totalEntriesSubmitted | Int | How many the user actually submitted |
| totalCorrections | Int | How many fields were changed |
| entriesAdded | Int | Entries the user added manually (AI missed) |
| entriesRemoved | Int | Entries the user deleted (AI hallucinated) |
| overallAiConfidence | Float | The AI's reported overall confidence |
| accuracyScore | Float | Calculated: 1 - (corrections / total fields) |
| createdAt | Date | Timestamp |

### 7.5.3 Correction Types Explained

- **wrong_match**: AI matched to the wrong project (e.g., "Smith" → Smith Residence but user corrected to Smith Office TI)
- **wrong_hours**: AI misread the hours (e.g., read 1.5 as 15, or 6 as 8)
- **wrong_phase**: AI got the project right but wrong phase (e.g., DD instead of CD)
- **wrong_memo**: AI suggested a memo the user replaced (less critical but still useful)
- **added_entry**: User added an entry the AI missed entirely — log what they added
- **removed_entry**: AI hallucinated an entry that didn't exist — log what was removed

### 7.5.4 How This Data Gets Used

**Immediate (v1):**
- Monthly manual review of correction logs to identify patterns
- Tune the system prompt based on common failures (e.g., if "CDs" is consistently misread as "CD", add it to the prompt)
- Adjust confidence thresholds (if entries at 85% confidence are frequently corrected, lower the flag threshold)

**v2 (Supabase):**
- Aggregate correction data across all users at a firm
- Build a firm-specific abbreviation dictionary (auto-learned from corrections)
- Dashboard showing AI accuracy trends over time
- Feed corrections back into prompt engineering automatically

**v3 (Scale):**
- Cross-firm correction data to improve the base model
- Fine-tuned model trained on real architect handwriting + corrections
- Per-user accuracy tracking (some people's handwriting may need user-specific tuning)

### 7.5.5 Privacy & Storage

- Correction logs do NOT store the original image (ScanResult already has it temporarily)
- In v1, corrections stay on-device in SQLite
- In v2, corrections sync to Supabase — stripped of memo content (just field name + correction type) to minimize sensitive data exposure
- Users can view their own correction history in Settings (future)

---

## Data Model Addition (add to Section 3.3)

```
ScanCorrection
├── id: UUID
├── scanResultId: UUID (FK → ScanResult)
├── entryIndex: Int
├── fieldName: Enum (project, phase, hours, memo)
├── aiValue: String
├── aiConfidence: Float
├── userValue: String
├── correctionType: Enum (wrong_match, wrong_hours, wrong_phase, wrong_memo, added_entry, removed_entry)
└── createdAt: Date

ScanSession (extend existing ScanResult)
├── totalEntriesParsed: Int
├── totalEntriesSubmitted: Int
├── totalCorrections: Int
├── entriesAdded: Int
├── entriesRemoved: Int
├── accuracyScore: Float
└── createdAt: Date
```

---

## Build Playbook Addition (add to Session 10 prompt)

Add this to the end of the Session 10 prompt:

```
SCAN CORRECTION LOGGING:

Add silent correction tracking to the review & submit flow.

1. When the AI parse results first load on the review screen, store a deep copy 
   of the parsed entries array as `originalEntries` in local state.

2. When the user taps "Submit to BQE Core", before sending the batch request, 
   run a diff between `originalEntries` and the current (possibly edited) entries:
   - For each entry that exists in both: compare project, phase, hours, memo fields
   - Any changed field → write a ScanCorrection record to SQLite
   - Entries in current but not original → log as `added_entry`
   - Entries in original but not current → log as `removed_entry`

3. Write a ScanSession summary record with totals.

4. This logging must be fire-and-forget — never block or delay the submission. 
   Wrap in try/catch, fail silently. The user should never know this is happening.

5. Add a ScanCorrection table and ScanSession table to db/schema.ts.
```
