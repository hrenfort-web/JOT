// v2: move to server-side proxy via Supabase Edge Function so the API key
// stops shipping inside the bundle.
import {
  ProjectLookupEntry,
  lookupTableToPromptString,
} from './matcher';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 2048;

export interface ParsedEntry {
  day: string;
  projectName: string;
  projectId: string | null;
  phaseCode: string | null;
  phaseProjectId: string | null;
  hours: number;
  memo: string | null;
  confidence: number;
}

export interface ParsedFlag {
  entryIndex: number;
  reason: string;
  suggestion?: string | number | null;
}

export interface ParsedTimesheet {
  entries: ParsedEntry[];
  overallConfidence: number;
  flags: ParsedFlag[];
}

interface ScanOptions {
  signal?: AbortSignal;
  mediaType?: 'image/jpeg' | 'image/png';
}

export async function parseTimesheetImage(
  base64Image: string,
  projectLookup: ProjectLookupEntry[],
  options: ScanOptions = {},
): Promise<ParsedTimesheet> {
  const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Anthropic API key not configured. Set EXPO_PUBLIC_ANTHROPIC_API_KEY in .env.',
    );
  }
  if (projectLookup.length === 0) {
    throw new Error('No projects available — sync with BQE Core first.');
  }

  const systemPrompt = buildSystemPrompt(projectLookup);

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: options.mediaType ?? 'image/jpeg',
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: 'Parse this timesheet image. Return ONLY the JSON object specified in the system prompt — no markdown fences, no commentary.',
          },
        ],
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`Network error contacting Anthropic: ${(e as Error).message}`);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Anthropic API ${response.status}: ${errorBody.slice(0, 240) || response.statusText}`,
    );
  }

  const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = extractText(data);
  return parseJsonResponse(text);
}

function buildSystemPrompt(lookup: ProjectLookupEntry[]): string {
  const lookupTable = lookupTableToPromptString(lookup);
  return `You are a timesheet parser for an architecture firm. You will receive a photo of handwritten time notes (or sometimes a screenshot of typed notes, or a whiteboard photo). Parse the entries and return structured JSON.

The user's active projects and phases are listed below. Always match shorthand names to the closest entry in this table. The "Phase ID" column is the BQE projectId we charge time to — that is what you must return as phaseProjectId.

${lookupTable}

Phase code definitions (when in doubt, prefer the table above):
- SD = Schematic Design
- DD = Design Development
- CD = Construction Documents
- CA = Construction Administration
- Meetings / MTG = Meeting time

Memo extraction:
- If the user wrote what they worked on next to their hours (e.g., "Smith DD 6.5 - struct coord"), extract that text into the memo field. Lightly clean abbreviations (e.g., "struct coord" -> "Structural coordination").
- If no memo was written, suggest a brief generic one based on the phase: SD -> "Schematic design", DD -> "Design development", CD -> "Construction documents", CA -> "Construction administration", otherwise the project's phase name.

Acceptable input shapes you must handle gracefully:
- Day-headed lists with indented project lines.
- Flat one-liners like "Mon Smith DD 6, Tue Oakwood CD 2".
- Heavy abbreviations like "S-DD 6.5" or "Oak CD 2".
- Whiteboard photos.
- Typed notes / Notes-app screenshots.

Confidence and flags:
- Set each entry's confidence to your subjective certainty in [0, 1]. Below 0.7 means something looked ambiguous.
- Add a flag for any entry where handwriting was unclear, or hours could be misread (e.g. "1.5" vs "15"), with a one-sentence reason and a numeric or string suggestion when possible.
- Set overallConfidence to your overall confidence in the whole parse.

Return JSON in EXACTLY this shape — no markdown fences, no surrounding prose:
{
  "entries": [
    {
      "day": "monday",
      "projectName": "Smith Residence",
      "projectId": "uuid-of-parent-project-or-null",
      "phaseCode": "DD",
      "phaseProjectId": "uuid-from-Phase-ID-column",
      "hours": 6.5,
      "memo": "Coordinating with structural engineer",
      "confidence": 0.97
    }
  ],
  "overallConfidence": 0.93,
  "flags": [
    {
      "entryIndex": 4,
      "reason": "Hours unclear — could be 1.5 or 15",
      "suggestion": 1.5
    }
  ]
}

If you cannot identify a project at all, set projectName to your best guess, projectId and phaseProjectId to null, and add a flag explaining the miss. Never invent a phaseProjectId that is not in the table above.`;
}

function extractText(data: { content?: Array<{ type: string; text?: string }> }): string {
  if (!data?.content) return '';
  const texts: string[] = [];
  for (const block of data.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
}

function parseJsonResponse(text: string): ParsedTimesheet {
  if (!text.trim()) throw new Error('Empty response from model');
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) body = fence[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Model did not return JSON');
  }
  const jsonStr = body.slice(start, end + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Could not parse JSON from model: ${(e as Error).message}`);
  }
  return normalizeParsed(raw);
}

function normalizeParsed(raw: unknown): ParsedTimesheet {
  const obj = (raw ?? {}) as Record<string, any>;
  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  const entries: ParsedEntry[] = rawEntries.map((e: Record<string, any>) => ({
    day: String(e.day ?? '').toLowerCase(),
    projectName: String(e.projectName ?? e.project_match ?? e.project_name ?? ''),
    projectId: e.projectId ?? e.project_id ?? null,
    phaseCode: nullableString(e.phaseCode ?? e.phase_code ?? e.phase),
    phaseProjectId: e.phaseProjectId ?? e.phase_project_id ?? null,
    hours: Number(e.hours ?? 0),
    memo: nullableString(e.memo ?? e.description),
    confidence: clamp01(Number(e.confidence ?? 0.5)),
  }));
  const rawFlags = Array.isArray(obj.flags) ? obj.flags : [];
  const flags: ParsedFlag[] = rawFlags.map((f: Record<string, any>) => ({
    entryIndex: Number(f.entryIndex ?? f.entry_index ?? 0),
    reason: String(f.reason ?? ''),
    suggestion: f.suggestion ?? null,
  }));
  return {
    entries,
    overallConfidence: clamp01(
      Number(obj.overallConfidence ?? obj.overall_confidence ?? 0.5),
    ),
    flags,
  };
}

function nullableString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
