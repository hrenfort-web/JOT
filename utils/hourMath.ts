export const MIN_HOURS = 0;
export const MAX_HOURS = 24;

export function snapToQuarter(value: number): number {
  return Math.round(value * 4) / 4;
}

export function clampHours(value: number): number {
  if (value < MIN_HOURS) return MIN_HOURS;
  if (value > MAX_HOURS) return MAX_HOURS;
  return value;
}

export function setHoursValue(value: number): number {
  return clampHours(snapToQuarter(value));
}

export function adjustHours(current: number, delta: number): number {
  return clampHours(snapToQuarter(current + delta));
}

export function formatEntryHours(hours: number): string {
  if (hours === 0) return '0';
  if (Number.isInteger(hours)) return String(hours);
  return hours.toFixed(2).replace(/\.?0+$/, '');
}
