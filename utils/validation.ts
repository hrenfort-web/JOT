import { fromIsoDay, toIsoDay } from './dateHelpers';

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export const HOURS_MIN = 0;
export const HOURS_MAX_PER_ENTRY = 24;
export const HOURS_MAX_PER_DAY = 24;
export const HOURS_SOFT_WARN_PER_ENTRY = 16;
export const MEMO_MIN = 3;
export const MEMO_MAX = 100;
export const ENTRY_PAST_DAYS_MAX = 30;

const OK: ValidationResult = { ok: true };

export function validateHours(hours: number): ValidationResult {
  if (!Number.isFinite(hours)) {
    return { ok: false, message: 'Enter a valid number of hours' };
  }
  if (hours <= HOURS_MIN) {
    return { ok: false, message: 'Add at least some hours first' };
  }
  if (hours > HOURS_MAX_PER_ENTRY) {
    return { ok: false, message: `A single entry can't exceed ${HOURS_MAX_PER_ENTRY} hours` };
  }
  return OK;
}

export function validateDayTotal(currentTotal: number, addingHours: number): ValidationResult {
  if (currentTotal + addingHours > HOURS_MAX_PER_DAY) {
    return {
      ok: false,
      message: `That puts your day over ${HOURS_MAX_PER_DAY} hours — please trim somewhere`,
    };
  }
  return OK;
}

export function validateMemo(memo: string): ValidationResult {
  const trimmed = memo.trim();
  if (trimmed.length < MEMO_MIN) {
    return { ok: false, message: `Memo must be at least ${MEMO_MIN} characters` };
  }
  if (memo.length > MEMO_MAX) {
    return { ok: false, message: `Memo can't exceed ${MEMO_MAX} characters` };
  }
  return OK;
}

export function validateEntryDate(iso: string, today: Date = new Date()): ValidationResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { ok: false, message: 'Pick a valid date' };
  }
  const date = fromIsoDay(iso);
  const todayKey = toIsoDay(today);
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() - ENTRY_PAST_DAYS_MAX);
  const cutoffKey = toIsoDay(cutoff);

  if (iso > todayKey) {
    return { ok: false, message: "Can't log time in the future" };
  }
  if (iso < cutoffKey) {
    return {
      ok: false,
      message: `Can't log more than ${ENTRY_PAST_DAYS_MAX} days back — that period may be locked`,
    };
  }
  return OK;
}

export function validateProjectAndPhase(
  projectId: string | null | undefined,
  phaseProjectId: string | null | undefined,
): ValidationResult {
  if (!projectId) return { ok: false, message: 'Pick a project first' };
  if (!phaseProjectId) return { ok: false, message: 'Pick a phase first' };
  return OK;
}

export function isHoursAboveSoftWarn(hours: number): boolean {
  return hours > HOURS_SOFT_WARN_PER_ENTRY;
}
