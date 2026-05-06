export function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const obj = data as Record<string, unknown> | null | undefined;
  if (obj && Array.isArray(obj.value)) return obj.value as T[];
  if (obj && Array.isArray(obj.data)) return obj.data as T[];
  if (obj && Array.isArray(obj.items)) return obj.items as T[];
  return [];
}

export function toBqeDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T00:00:00`;
}

export function toIsoDay(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
