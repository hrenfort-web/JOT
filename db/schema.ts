import { colorForId } from '../utils/projectColors';

export const MIGRATIONS: string[] = [
  `ALTER TABLE LocalTimeEntry ADD COLUMN billStatus TEXT`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN version TEXT`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN submissionStatus TEXT`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN retryCount INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN lastError TEXT`,
  // Studio G filters phases by BQE contract-type enum (see project.ts).
  // Existing installs need this column added before saveProjects can write it.
  // SQLite type affinity is loose, so even if an early build added this as
  // TEXT, the read-side coercion in projectFromRow normalises everything to
  // a number.
  `ALTER TABLE LocalProject ADD COLUMN contractType INTEGER`,
  // Scan correction logging — silently track AI accuracy so we can improve
  // parsing over time. Both tables stay on-device in v1; v2 will sync to
  // Supabase. CREATE TABLE IF NOT EXISTS is idempotent for fresh installs;
  // these migration entries cover existing databases that pre-date the
  // schema additions.
  `CREATE TABLE IF NOT EXISTS ScanSession (
    id TEXT PRIMARY KEY,
    totalEntriesParsed INTEGER NOT NULL DEFAULT 0,
    totalEntriesSubmitted INTEGER NOT NULL DEFAULT 0,
    totalCorrections INTEGER NOT NULL DEFAULT 0,
    entriesAdded INTEGER NOT NULL DEFAULT 0,
    entriesRemoved INTEGER NOT NULL DEFAULT 0,
    overallAiConfidence REAL,
    accuracyScore REAL,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ScanCorrection (
    id TEXT PRIMARY KEY,
    scanSessionId TEXT NOT NULL,
    entryIndex INTEGER NOT NULL,
    fieldName TEXT NOT NULL,
    aiValue TEXT,
    aiConfidence REAL,
    userValue TEXT,
    correctionType TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (scanSessionId) REFERENCES ScanSession(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scancorrection_session ON ScanCorrection(scanSessionId)`,
  // [DEPRECATED for activity-selection] Project → group via /projectassignment.
  // Studio G doesn't populate /projectassignment, so this column stays empty
  // for them. Kept for forward compat (some other firms may use it). The
  // current activity-selection path goes through LocalProjectActivityGroup
  // (sourced from /project/{id}/activities) and LocalGroup below.
  `ALTER TABLE LocalProject ADD COLUMN groupId TEXT`,
  `CREATE TABLE IF NOT EXISTS LocalGroup (
    id TEXT PRIMARY KEY,
    name TEXT,
    activityIds TEXT NOT NULL DEFAULT '[]',
    lastSynced TEXT NOT NULL
  )`,
  // Project ↔ activity-group membership. Each row binds a project to one of
  // its assigned activity groups (the BQE `itemType: 139` records returned
  // by GET /project/{id}/activities). Activities allowed for a project are
  // the union of LocalGroup.activityIds across that project's groups.
  // Replaces the LocalProject.groupId mechanism for activity selection.
  //
  // (Pre-launch: SCHEMA's CREATE TABLE IF NOT EXISTS covers new installs,
  // this migration covers anyone who launched a prior dev build. Post-launch
  // any further schema changes need proper ALTER TABLE migrations.)
  `CREATE TABLE IF NOT EXISTS LocalProjectActivityGroup (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    groupId TEXT NOT NULL,
    groupName TEXT,
    itemType INTEGER,
    lastSynced TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lpag_project ON LocalProjectActivityGroup(projectId)`,
  `CREATE INDEX IF NOT EXISTS idx_lpag_group ON LocalProjectActivityGroup(groupId)`,
  // Firm-level preferences. Single-row-per-key table. Currently holds
  // `activitySelectionMode` (auto|manual) and `activityGroupsLastFullSync`
  // (ISO timestamp written by backgroundSync). Future settings (timezone
  // overrides, per-firm feature flags) can land here without a schema bump.
  `CREATE TABLE IF NOT EXISTS LocalFirmSettings (
    key TEXT PRIMARY KEY,
    value TEXT,
    lastUpdated TEXT NOT NULL
  )`,
  `INSERT OR IGNORE INTO LocalFirmSettings (key, value, lastUpdated)
   VALUES ('activitySelectionMode', 'auto', '1970-01-01T00:00:00.000Z')`,
];

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS LocalProject (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  clientName TEXT,
  parentId TEXT,
  isPhase INTEGER NOT NULL DEFAULT 0,
  phaseCode TEXT,
  isActive INTEGER NOT NULL DEFAULT 1,
  color TEXT,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  lastSynced TEXT NOT NULL,
  -- BQE returns the contract-type enum as an integer (sometimes as a numeric
  -- string; we coerce on read in projectFromRow). See ALLOWED_CONTRACT_TYPES
  -- in services/bqe/project.ts for the enum values.
  contractType INTEGER,
  -- BQE group assignment id. Determines which activities are allowed when
  -- POSTing a time entry against this project (see LocalGroup.activityIds).
  -- Nullable: some projects may not have a group assigned.
  groupId TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_parent ON LocalProject(parentId);
CREATE INDEX IF NOT EXISTS idx_project_active ON LocalProject(isActive);

CREATE TABLE IF NOT EXISTS LocalActivity (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  isBillable INTEGER NOT NULL DEFAULT 1,
  isActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS LocalEmployee (
  id TEXT PRIMARY KEY,
  displayName TEXT,
  firstName TEXT,
  lastName TEXT,
  role TEXT,
  standardHoursPerWeek REAL DEFAULT 40
);

CREATE TABLE IF NOT EXISTS LocalTimeEntry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bqeId TEXT UNIQUE,
  projectId TEXT NOT NULL,
  activityId TEXT NOT NULL,
  resourceId TEXT NOT NULL,
  date TEXT NOT NULL,
  hours REAL NOT NULL,
  memo TEXT,
  isBillable INTEGER NOT NULL DEFAULT 1,
  syncStatus TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  createdAt TEXT NOT NULL,
  billStatus TEXT,
  version TEXT,
  submissionStatus TEXT,
  retryCount INTEGER NOT NULL DEFAULT 0,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_entry_resource_date ON LocalTimeEntry(resourceId, date);
CREATE INDEX IF NOT EXISTS idx_entry_sync ON LocalTimeEntry(syncStatus);

-- Scan correction logging. Both tables are local-only in v1 and ferry
-- AI-vs-user-edit deltas so we can later analyse where the parser is weak.
-- Privacy note: ScanCorrection.aiValue / userValue may contain memo strings.
-- Memo content must be stripped before any v2 Supabase upload.
CREATE TABLE IF NOT EXISTS ScanSession (
  id TEXT PRIMARY KEY,
  totalEntriesParsed INTEGER NOT NULL DEFAULT 0,
  totalEntriesSubmitted INTEGER NOT NULL DEFAULT 0,
  totalCorrections INTEGER NOT NULL DEFAULT 0,
  entriesAdded INTEGER NOT NULL DEFAULT 0,
  entriesRemoved INTEGER NOT NULL DEFAULT 0,
  overallAiConfidence REAL,
  accuracyScore REAL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ScanCorrection (
  id TEXT PRIMARY KEY,
  scanSessionId TEXT NOT NULL,
  entryIndex INTEGER NOT NULL,
  fieldName TEXT NOT NULL,
  aiValue TEXT,
  aiConfidence REAL,
  userValue TEXT,
  correctionType TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (scanSessionId) REFERENCES ScanSession(id)
);
CREATE INDEX IF NOT EXISTS idx_scancorrection_session ON ScanCorrection(scanSessionId);

-- Group activity catalog. Each LocalGroup row caches the FULL list of
-- activity ids allowed for time entries against any project assigned to
-- that group (not filtered to billable — the resolver filters at read
-- time). activityIds is a JSON-encoded TEXT array; parsed in groupFromRow.
CREATE TABLE IF NOT EXISTS LocalGroup (
  id TEXT PRIMARY KEY,
  name TEXT,
  activityIds TEXT NOT NULL DEFAULT '[]',
  lastSynced TEXT NOT NULL
);

-- Project → activity-group membership (many-to-many). Replaces the
-- deprecated LocalProject.groupId mechanism. Populated by
-- services/bqe/projectActivities from GET /project/{id}/activities.
CREATE TABLE IF NOT EXISTS LocalProjectActivityGroup (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  groupId TEXT NOT NULL,
  groupName TEXT,
  itemType INTEGER,
  lastSynced TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lpag_project ON LocalProjectActivityGroup(projectId);
CREATE INDEX IF NOT EXISTS idx_lpag_group ON LocalProjectActivityGroup(groupId);

-- Firm-level preferences. Key-value rows. activitySelectionMode is
-- read by the activity resolver; activityGroupsLastFullSync is written
-- by services/sync/backgroundSync.
CREATE TABLE IF NOT EXISTS LocalFirmSettings (
  key TEXT PRIMARY KEY,
  value TEXT,
  lastUpdated TEXT NOT NULL
);
INSERT OR IGNORE INTO LocalFirmSettings (key, value, lastUpdated)
  VALUES ('activitySelectionMode', 'auto', '1970-01-01T00:00:00.000Z');
`;

export interface LocalProjectRow {
  id: string;
  name: string;
  code: string | null;
  clientName: string | null;
  parentId: string | null;
  isPhase: number;
  phaseCode: string | null;
  isActive: number;
  color: string | null;
  sortOrder: number;
  lastSynced: string;
  // SQLite affinity may return this as either a number or numeric string
  // depending on which migration produced the column. Always normalised to
  // `number | null` by `projectFromRow` before downstream code sees it.
  contractType: number | string | null;
  groupId: string | null;
}

export interface LocalProject {
  id: string;
  name: string;
  code: string | null;
  clientName: string | null;
  parentId: string | null;
  isPhase: boolean;
  phaseCode: string | null;
  isActive: boolean;
  color: string | null;
  sortOrder: number;
  lastSynced: string;
  contractType: number | null;
  groupId: string | null;
}

export interface LocalActivityRow {
  id: string;
  name: string;
  code: string | null;
  isBillable: number;
  isActive: number;
}

export interface LocalActivity {
  id: string;
  name: string;
  code: string | null;
  isBillable: boolean;
  isActive: boolean;
}

export interface LocalEmployeeRow {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  standardHoursPerWeek: number | null;
}

export type LocalEmployee = LocalEmployeeRow;

export type SyncStatus = 'pending' | 'synced' | 'failed' | 'conflict';
export type EntrySource = 'manual' | 'scanned' | 'voice' | 'prefilled';

export interface LocalTimeEntryRow {
  id: number;
  bqeId: string | null;
  projectId: string;
  activityId: string;
  resourceId: string;
  date: string;
  hours: number;
  memo: string | null;
  isBillable: number;
  syncStatus: SyncStatus;
  source: EntrySource;
  createdAt: string;
  billStatus: string | null;
  version: string | null;
  submissionStatus: string | null;
  retryCount: number;
  lastError: string | null;
}

export interface LocalTimeEntry {
  id: number;
  bqeId: string | null;
  projectId: string;
  activityId: string;
  resourceId: string;
  date: string;
  hours: number;
  memo: string | null;
  isBillable: boolean;
  syncStatus: SyncStatus;
  source: EntrySource;
  createdAt: string;
  billStatus: string | null;
  version: string | null;
  submissionStatus: string | null;
  retryCount: number;
  lastError: string | null;
}

export function projectFromRow(row: LocalProjectRow): LocalProject {
  // Coerce contractType once at the read boundary so every consumer can rely
  // on `number | null`. Handles BQE returning a numeric string (e.g. "4"),
  // SQLite TEXT-affinity columns from older migrations, and genuine numbers.
  let contractType: number | null = null;
  if (row.contractType != null) {
    const n = Number(row.contractType);
    contractType = Number.isFinite(n) ? n : null;
  }
  // Resolve the project dot colour at read time, NOT from the row.color
  // column. The column persists for back-compat but its value is stale on
  // any install that synced under the prior palette. utils/projectColors
  // owns the single source of truth — see that file for the full rationale.
  // Phases stay null (matches the prior behaviour where saveProjects wrote
  // null for isPhase rows; the parent project carries the identity dot).
  const isPhase = !!row.isPhase;
  const color = isPhase ? null : colorForId(row.id);
  return {
    ...row,
    isPhase,
    isActive: !!row.isActive,
    contractType,
    color,
  };
}

export function activityFromRow(row: LocalActivityRow): LocalActivity {
  return {
    ...row,
    isBillable: !!row.isBillable,
    isActive: !!row.isActive,
  };
}

// --- BQE group assignment cache -------------------------------------------

export interface LocalGroupRow {
  id: string;
  name: string | null;
  activityIds: string; // JSON-encoded string[]
  lastSynced: string;
}

export interface LocalGroup {
  id: string;
  name: string | null;
  activityIds: string[];
  lastSynced: string;
}

export function groupFromRow(row: LocalGroupRow): LocalGroup {
  let activityIds: string[] = [];
  if (row.activityIds) {
    try {
      const parsed = JSON.parse(row.activityIds);
      if (Array.isArray(parsed)) {
        activityIds = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // Corrupt JSON in the cache — treat as empty list. Next sync overwrites.
      activityIds = [];
    }
  }
  return {
    id: row.id,
    name: row.name,
    activityIds,
    lastSynced: row.lastSynced,
  };
}

// --- Project ↔ activity-group membership ---------------------------------

export interface LocalProjectActivityGroupRow {
  id: string;
  projectId: string;
  groupId: string;
  groupName: string | null;
  itemType: number | null;
  lastSynced: string;
}

export type LocalProjectActivityGroup = LocalProjectActivityGroupRow;

// --- Firm settings -------------------------------------------------------

export interface LocalFirmSettingRow {
  key: string;
  value: string | null;
  lastUpdated: string;
}

export type LocalFirmSetting = LocalFirmSettingRow;

export function entryFromRow(row: LocalTimeEntryRow): LocalTimeEntry {
  return {
    ...row,
    isBillable: !!row.isBillable,
  };
}

// --- Scan correction analytics --------------------------------------------

export type ScanCorrectionField = 'project' | 'phase' | 'hours' | 'memo';
export type ScanCorrectionType =
  | 'wrong_match'
  | 'wrong_hours'
  | 'wrong_phase'
  | 'wrong_memo'
  | 'added_entry'
  | 'removed_entry';

export interface ScanSessionRow {
  id: string;
  totalEntriesParsed: number;
  totalEntriesSubmitted: number;
  totalCorrections: number;
  entriesAdded: number;
  entriesRemoved: number;
  overallAiConfidence: number | null;
  accuracyScore: number | null;
  createdAt: string;
}

export interface ScanCorrectionRow {
  id: string;
  scanSessionId: string;
  entryIndex: number;
  fieldName: ScanCorrectionField | string;
  aiValue: string | null;
  aiConfidence: number | null;
  userValue: string | null;
  correctionType: ScanCorrectionType | string;
  createdAt: string;
}
