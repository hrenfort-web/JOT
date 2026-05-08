// Scan correction logging.
//
// Silently records the diff between what the AI parsed and what the user
// actually submitted, so we can later analyse where the parser is weak.
// All writes go to local SQLite (ScanSession + ScanCorrection tables).
//
// CRITICAL DESIGN RULE: this module never blocks or rejects on the user's
// submit path. Every public function wraps its body in try/catch and
// swallows errors. Callers fire-and-forget (`logScanSession(...).catch(() => {})`).
//
// PRIVACY: aiValue / userValue may contain memo content. v1 keeps it on
// device. TODO(v2): when syncing to Supabase, strip memo strings — only
// the field name + correction type + confidence should leave the device.

import { run } from '../../db/database';
import type {
  ScanCorrectionField,
  ScanCorrectionType,
} from '../../db/schema';
import type { ParsedEntry } from '../ai/scanner';

/**
 * Lookup over `flatProjects` provided by the caller. Phase rows have
 * `parentId` (the BQE projectId of the parent project) and `phaseCode`
 * (e.g. "DD"). Used to resolve a phaseProjectId to its parent + code so
 * the diff can compare project / phase fields between original and
 * submitted entries.
 */
export interface ProjectLookup {
  get(id: string): { parentId: string | null; phaseCode: string | null } | undefined;
}

/**
 * Shape the caller (review screen) builds for each entry it's about to
 * submit. `originalIndex` is the index this entry occupied in the AI's
 * original `entries` array, or `null` if the user added it after the scan.
 */
export interface SubmittedEntry {
  originalIndex: number | null;
  phaseProjectId: string | null;
  hours: number;
  memo: string;
}

interface LogInput {
  sessionId: string;
  originalEntries: ParsedEntry[];
  submittedEntries: SubmittedEntry[];
  overallAiConfidence: number;
  projectsById: ProjectLookup;
}

/**
 * Best-effort UUID v4. Uses the global crypto.randomUUID when available
 * (RN 0.74+ on Hermes) and falls back to a Math.random()-based generator.
 * Local-only IDs — no need for cryptographic strength.
 */
export function buildSessionId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    try {
      return g.crypto.randomUUID();
    } catch {
      // fall through to manual generator
    }
  }
  return manualUuid();
}

function manualUuid(): string {
  // RFC4122 v4-shape, non-cryptographic.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Diff originalEntries against submittedEntries and write a ScanSession
 * summary row plus one ScanCorrection row per detected change.
 *
 * Errors are swallowed internally — this function never throws. Callers
 * should still treat it as fire-and-forget (don't await on the submit
 * path) so a slow SQLite write can't delay the user.
 */
export async function logScanSession(input: LogInput): Promise<void> {
  try {
    await runLog(input);
  } catch {
    // Swallow — analytics must never affect the user's submission.
  }
}

async function runLog(input: LogInput): Promise<void> {
  const {
    sessionId,
    originalEntries,
    submittedEntries,
    overallAiConfidence,
    projectsById,
  } = input;
  const now = new Date().toISOString();

  const matched: Array<{ original: ParsedEntry; submitted: SubmittedEntry; index: number }> = [];
  const submittedOriginalIndexes = new Set<number>();
  const added: SubmittedEntry[] = [];

  for (const sub of submittedEntries) {
    if (sub.originalIndex == null) {
      added.push(sub);
      continue;
    }
    submittedOriginalIndexes.add(sub.originalIndex);
    const original = originalEntries[sub.originalIndex];
    if (original) {
      matched.push({ original, submitted: sub, index: sub.originalIndex });
    } else {
      // Original index out of range — treat as added so we don't drop the
      // signal. Shouldn't happen in practice; defensive only.
      added.push(sub);
    }
  }

  const removed: Array<{ entry: ParsedEntry; index: number }> = [];
  for (let i = 0; i < originalEntries.length; i++) {
    if (!submittedOriginalIndexes.has(i)) {
      removed.push({ entry: originalEntries[i], index: i });
    }
  }

  const corrections: CorrectionRow[] = [];

  for (const { original, submitted, index } of matched) {
    corrections.push(...diffMatchedEntry(original, submitted, index, projectsById));
  }
  for (const sub of added) {
    corrections.push({
      entryIndex: -1,
      fieldName: 'project',
      aiValue: '',
      aiConfidence: 0,
      userValue: summariseSubmitted(sub, projectsById),
      correctionType: 'added_entry',
    });
  }
  for (const { entry, index } of removed) {
    corrections.push({
      entryIndex: index,
      fieldName: 'project',
      aiValue: summariseParsed(entry),
      aiConfidence: clamp01(entry.confidence),
      userValue: '',
      correctionType: 'removed_entry',
    });
  }

  // Total fields compared = 4 per matched entry (project, phase, hours, memo)
  // + 1 per added or removed (the entry as a whole). When nothing was
  // parsed, the score has no meaning — null avoids forcing a 0 or 1 lie.
  const matchedFields = matched.length * 4;
  const totalFieldsCompared = matchedFields + added.length + removed.length;
  const accuracyScore =
    totalFieldsCompared > 0
      ? Math.max(0, Math.min(1, 1 - corrections.length / totalFieldsCompared))
      : null;

  await run(
    `INSERT INTO ScanSession (
       id, totalEntriesParsed, totalEntriesSubmitted, totalCorrections,
       entriesAdded, entriesRemoved, overallAiConfidence, accuracyScore, createdAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      originalEntries.length,
      submittedEntries.length,
      corrections.length,
      added.length,
      removed.length,
      Number.isFinite(overallAiConfidence) ? overallAiConfidence : null,
      accuracyScore,
      now,
    ],
  );

  for (const c of corrections) {
    await run(
      `INSERT INTO ScanCorrection (
         id, scanSessionId, entryIndex, fieldName,
         aiValue, aiConfidence, userValue, correctionType, createdAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        manualUuid(),
        sessionId,
        c.entryIndex,
        c.fieldName,
        c.aiValue,
        c.aiConfidence,
        c.userValue,
        c.correctionType,
        now,
      ],
    );
  }
}

interface CorrectionRow {
  entryIndex: number;
  fieldName: ScanCorrectionField | 'project';
  aiValue: string;
  aiConfidence: number;
  userValue: string;
  correctionType: ScanCorrectionType;
}

function diffMatchedEntry(
  original: ParsedEntry,
  submitted: SubmittedEntry,
  index: number,
  projectsById: ProjectLookup,
): CorrectionRow[] {
  const out: CorrectionRow[] = [];
  const aiConfidence = clamp01(original.confidence);

  // --- project (compare by parent projectId, not display name) ----------
  const aiParent = parentOfPhase(original.phaseProjectId, projectsById) ?? original.projectId ?? null;
  const userParent = parentOfPhase(submitted.phaseProjectId, projectsById);
  if ((aiParent ?? '') !== (userParent ?? '')) {
    out.push({
      entryIndex: index,
      fieldName: 'project',
      aiValue: original.projectName ?? aiParent ?? '',
      aiConfidence,
      userValue: userParent ?? '',
      correctionType: 'wrong_match',
    });
  }

  // --- phase (compare phase code) ---------------------------------------
  const aiPhaseCode = original.phaseCode ?? null;
  const userPhaseCode = phaseCodeOf(submitted.phaseProjectId, projectsById);
  if ((aiPhaseCode ?? '') !== (userPhaseCode ?? '')) {
    out.push({
      entryIndex: index,
      fieldName: 'phase',
      aiValue: aiPhaseCode ?? '',
      aiConfidence,
      userValue: userPhaseCode ?? '',
      correctionType: 'wrong_phase',
    });
  }

  // --- hours (numeric, tolerate IEEE float noise) -----------------------
  if (Math.abs(original.hours - submitted.hours) > 0.001) {
    out.push({
      entryIndex: index,
      fieldName: 'hours',
      aiValue: String(original.hours),
      aiConfidence,
      userValue: String(submitted.hours),
      correctionType: 'wrong_hours',
    });
  }

  // --- memo (string, trim-tolerant) -------------------------------------
  const aiMemo = (original.memo ?? '').trim();
  const userMemo = (submitted.memo ?? '').trim();
  if (aiMemo !== userMemo) {
    out.push({
      entryIndex: index,
      fieldName: 'memo',
      aiValue: original.memo ?? '',
      aiConfidence,
      userValue: submitted.memo ?? '',
      correctionType: 'wrong_memo',
    });
  }

  return out;
}

function parentOfPhase(
  phaseProjectId: string | null,
  projectsById: ProjectLookup,
): string | null {
  if (!phaseProjectId) return null;
  const p = projectsById.get(phaseProjectId);
  if (!p) return null;
  // If the lookup row has no parentId, the phaseProjectId IS the parent
  // project (single-phase project case).
  return p.parentId ?? phaseProjectId;
}

function phaseCodeOf(
  phaseProjectId: string | null,
  projectsById: ProjectLookup,
): string | null {
  if (!phaseProjectId) return null;
  const p = projectsById.get(phaseProjectId);
  return p?.phaseCode ?? null;
}

function summariseParsed(e: ParsedEntry): string {
  return JSON.stringify({
    day: e.day,
    project: e.projectName ?? null,
    phaseCode: e.phaseCode ?? null,
    phaseProjectId: e.phaseProjectId ?? null,
    hours: e.hours,
    memo: e.memo ?? null,
  });
}

function summariseSubmitted(
  e: SubmittedEntry,
  projectsById: ProjectLookup,
): string {
  return JSON.stringify({
    parentProjectId: parentOfPhase(e.phaseProjectId, projectsById),
    phaseProjectId: e.phaseProjectId,
    phaseCode: phaseCodeOf(e.phaseProjectId, projectsById),
    hours: e.hours,
    memo: e.memo,
  });
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
