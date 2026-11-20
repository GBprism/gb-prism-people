// Date helpers. All business dates are ISO yyyy-mm-dd strings interpreted as
// calendar dates (no time zone). "Today" is computed in Asia/Amman.
export const TZ = 'Asia/Amman';

export function todayIn(tz = TZ, at = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return p; // en-CA formats as yyyy-mm-dd
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const parse = (s) => new Date(s + 'T00:00:00Z');
export const fmt = (d) => d.toISOString().slice(0, 10);
export function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
export const weekday = (s) => parse(s).getUTCDay(); // 0 = Sunday
export function* eachDay(from, to) { for (let d = from; d <= to; d = addDays(d, 1)) yield d; }
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

/** Business days from a → b (exclusive of a), counting only workweek days. */
export function businessDaysBetween(a, b, workweek = [0, 1, 2, 3, 4], holidays = new Set()) {
  let n = 0;
  if (b <= a) return 0;
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (workweek.includes(weekday(d)) && !holidays.has(d)) n++;
  return n;
}
export function addBusinessDays(s, n, workweek = [0, 1, 2, 3, 4], holidays = new Set()) {
  let d = s; const step = n >= 0 ? 1 : -1; let left = Math.abs(n);
  while (left > 0) { d = addDays(d, step); if (workweek.includes(weekday(d)) && !holidays.has(d)) left--; }
  return d;
}
