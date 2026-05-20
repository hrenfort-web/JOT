import { getAll } from '../../db/database';
import { toIsoDay } from '../../utils/dateHelpers';
import { getMemoTemplatesForPhase } from '../firmSettings';

export const PHASE_DEFAULTS: Record<string, string[]> = {
  SD: ['Concept development', 'Site analysis', 'Programming', 'Client meeting'],
  DD: ['Drawing development', 'Coordination', 'Consultant review', 'Design revisions'],
  CD: ['Document production', 'Detail development', 'Code review', 'Spec writing'],
  CA: ['RFI review', 'Submittal review', 'Site visit', 'Punch list'],
  MTG: ['Team coordination', 'Client meeting', 'Consultant coordination'],
  PA: ['Site research', 'Code review', 'Initial sketches'],
  PM: ['Team coordination', 'Schedule review', 'Status update'],
  ADM: ['Admin', 'Email', 'Filing'],
};

const GENERIC_DEFAULTS = ['Project work', 'Coordination', 'Documentation', 'Meeting'];

const MAX_CHIPS = 5;
const RECENT_LOOKBACK_DAYS = 30;

interface MemoRow {
  memo: string | null;
}

export interface MemoSuggestions {
  label: string;
  chips: string[];
  hasHistory: boolean;
}

export async function fetchRecentMemos(projectId: string): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENT_LOOKBACK_DAYS);
  const rows = await getAll<MemoRow>(
    `SELECT memo FROM LocalTimeEntry
     WHERE projectId = ? AND date >= ? AND memo IS NOT NULL AND memo != ''
     ORDER BY id DESC`,
    [projectId, toIsoDay(cutoff)],
  );

  const counts = new Map<string, number>();
  for (const r of rows) {
    const memo = r.memo?.trim();
    if (!memo || memo.length < 3) continue;
    counts.set(memo, (counts.get(memo) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([memo]) => memo);
}

export async function getMemoSuggestions(
  projectId: string,
  phaseCode: string | null,
  phaseName?: string | null,
): Promise<MemoSuggestions> {
  const recent = await fetchRecentMemos(projectId);

  // Template priority: firm-specific phase-name templates win over the
  // generic phase-code defaults, which win over GENERIC_DEFAULTS. Firm
  // templates are matched by normalized phase NAME (e.g. "20 Schematic
  // Design"), which is what Studio G's phases carry — their names don't
  // yield a phaseCode, so without this tier they fell through to generic.
  const firmTemplates = phaseName ? await getMemoTemplatesForPhase(phaseName) : null;
  const phaseList =
    firmTemplates ??
    (phaseCode ? PHASE_DEFAULTS[phaseCode.toUpperCase()] : undefined) ??
    GENERIC_DEFAULTS;

  const chips: string[] = [];
  const seen = new Set<string>();
  for (const memo of [...recent, ...phaseList]) {
    const key = memo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(memo);
    if (chips.length === MAX_CHIPS) break;
  }

  const hasHistory = recent.length > 0;
  const label = hasHistory
    ? 'Your recent memos'
    : `Suggested for ${phaseName ?? phaseCode ?? 'this phase'}`;

  return { label, chips, hasHistory };
}
