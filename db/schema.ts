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
  contractType INTEGER
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
  return {
    ...row,
    isPhase: !!row.isPhase,
    isActive: !!row.isActive,
    contractType,
  };
}

export function activityFromRow(row: LocalActivityRow): LocalActivity {
  return {
    ...row,
    isBillable: !!row.isBillable,
    isActive: !!row.isActive,
  };
}

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
