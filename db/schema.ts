export const MIGRATIONS: string[] = [
  `ALTER TABLE LocalTimeEntry ADD COLUMN billStatus TEXT`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN version TEXT`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN submissionStatus TEXT`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN retryCount INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE LocalTimeEntry ADD COLUMN lastError TEXT`,
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
  lastSynced TEXT NOT NULL
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
  return {
    ...row,
    isPhase: !!row.isPhase,
    isActive: !!row.isActive,
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
