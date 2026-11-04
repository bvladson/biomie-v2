/** ISO dates (YYYY-MM-DD) handled in UTC, without time zone, for deterministic Flight Plan math. */
export const toDate = (iso: string) => new Date(iso + "T00:00:00Z");
export const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};
export const diffDays = (a: string, b: string) =>
  Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86_400_000);
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (iso: string) => toDate(iso).getUTCDay();
export const monthOf = (iso: string) => iso.slice(0, 7);
export const monthStart = (month: string) => `${month}-01`;
export const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return toIso(new Date(Date.UTC(y, m, 0)));
};
export const addMonths = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return toIso(new Date(Date.UTC(y, m - 1 + n, 1))).slice(0, 7);
};
export const daysOfMonth = (month: string) => {
  const out: string[] = [];
  for (let d = monthStart(month); d <= monthEnd(month); d = addDays(d, 1)) out.push(d);
  return out;
};
/** Monday of the (Monday–Sunday) week that contains the date. */
export const mondayOf = (iso: string) => addDays(iso, -((weekday(iso) + 6) % 7));
/** Monday of the previous week when today is Monday, else Monday of this week. */
export const lastMonday = (today: string) =>
  weekday(today) === 1 ? addDays(today, -7) : mondayOf(today);
export const quarterMonths = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const q = Math.floor((m - 1) / 3);
  return [1, 2, 3].map((i) => `${y}-${String(q * 3 + i).padStart(2, "0")}`);
};
export const yearMonths = (year: number) =>
  Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
