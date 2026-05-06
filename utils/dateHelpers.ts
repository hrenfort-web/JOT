export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function getMonday(date: Date = new Date()): Date {
  const d = startOfDay(date);
  const day = d.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  return d;
}

export function getSunday(date: Date = new Date()): Date {
  const monday = getMonday(date);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return sunday;
}

export function getWeekDays(start: Date, count: number = 7): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const SHORT_DAY_LABELS = ['M', 'T', 'W', 'Th', 'F', 'S', 'Su'];

export function shortDayLabel(date: Date): string {
  const day = date.getDay();
  const idx = day === 0 ? 6 : day - 1;
  return SHORT_DAY_LABELS[idx];
}

export function toIsoDay(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function fromIsoDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function formatHours(hours: number): string {
  if (hours === 0) return '0';
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/\.?0+$/, '');
}
