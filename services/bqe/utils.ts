export function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const obj = data as Record<string, unknown> | null | undefined;
  if (obj && Array.isArray(obj.value)) return obj.value as T[];
  if (obj && Array.isArray(obj.data)) return obj.data as T[];
  if (obj && Array.isArray(obj.items)) return obj.items as T[];
  return [];
}

const DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

function dayPartsFromString(value: string): { y: number; m: number; d: number } | null {
  const match = value.match(DAY_PREFIX);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function localParts(date: Date): { y: number; m: number; d: number } {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

function formatYmd(parts: { y: number; m: number; d: number }, suffix: string = ''): string {
  const yyyy = String(parts.y);
  const mm = String(parts.m).padStart(2, '0');
  const dd = String(parts.d).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}${suffix}`;
}

// Day-only formatters: strings shaped like YYYY-MM-DD (or YYYY-MM-DDT...) are treated
// as a calendar day in the user's LOCAL timezone — never round-tripped through
// `new Date(string)`, which would parse a date-only string as UTC midnight and shift
// it a day in timezones west of UTC.
export function toIsoDay(date: Date | string): string {
  if (typeof date === 'string') {
    const parts = dayPartsFromString(date);
    if (parts) return formatYmd(parts);
    return formatYmd(localParts(new Date(date)));
  }
  return formatYmd(localParts(date));
}

export function toBqeDate(date: Date | string): string {
  if (typeof date === 'string') {
    const parts = dayPartsFromString(date);
    if (parts) return formatYmd(parts, 'T00:00:00');
    return formatYmd(localParts(new Date(date)), 'T00:00:00');
  }
  return formatYmd(localParts(date), 'T00:00:00');
}
