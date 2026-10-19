/**
 * PeriodComparisonService — the single place comparison windows are defined.
 * Pages never compute comparison ranges by hand.
 *
 * Rules:
 * - The current period runs from the 1st to min(month end, asOf).
 * - PREVIOUS_PERIOD / SAME_PERIOD_LAST_YEAR use the SAME cut (same number of
 *   days elapsed) while the month is open; full months once closed.
 * - TRAILING_N_MONTH_AVERAGE = total of the N full months before the period ÷ N.
 */
import { delta } from "@/domain/metrics/compute";

export type ComparisonKind =
  | "PREVIOUS_PERIOD"
  | "SAME_PERIOD_LAST_YEAR"
  | "TRAILING_3_MONTH_AVERAGE"
  | "TRAILING_12_MONTH_AVERAGE";

export const COMPARISON_LABELS: Record<ComparisonKind, string> = {
  PREVIOUS_PERIOD: "vs mês anterior",
  SAME_PERIOD_LAST_YEAR: "vs ano anterior",
  TRAILING_3_MONTH_AVERAGE: "vs média 3m",
  TRAILING_12_MONTH_AVERAGE: "vs média 12m",
};

export interface DateRange {
  start: string;
  end: string;
  /** Divisor for averages (1 for plain periods). */
  divisor: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const lastDay = (y: number, m: number) => utc(y, m + 1, 0).getUTCDate();

export function periodRange(
  period: string,
  asOf: string,
): DateRange & { state: "future" | "current" | "closed" } {
  const [y = 0, m = 1] = period.split("-").map(Number);
  const start = iso(utc(y, m, 1));
  const end = iso(utc(y, m, lastDay(y, m)));
  const state = asOf < start ? "future" : asOf > end ? "closed" : "current";
  return { start, end: state === "current" ? asOf : end, divisor: 1, state };
}

function shiftMonthRange(period: string, asOf: string, months: number): DateRange {
  const [y = 0, m = 1] = period.split("-").map(Number);
  const cur = periodRange(period, asOf);
  const t = utc(y, m + months, 1);
  const ty = t.getUTCFullYear();
  const tm = t.getUTCMonth() + 1;
  const last = lastDay(ty, tm);
  let endDay = last;
  if (cur.state === "current") endDay = Math.min(Number(asOf.slice(8, 10)), last);
  return { start: iso(t), end: iso(utc(ty, tm, endDay)), divisor: 1 };
}

export function comparisonRange(kind: ComparisonKind, period: string, asOf: string): DateRange {
  const [y = 0, m = 1] = period.split("-").map(Number);
  switch (kind) {
    case "PREVIOUS_PERIOD":
      return shiftMonthRange(period, asOf, -1);
    case "SAME_PERIOD_LAST_YEAR":
      return shiftMonthRange(period, asOf, -12);
    case "TRAILING_3_MONTH_AVERAGE":
      return { start: iso(utc(y, m - 3, 1)), end: iso(utc(y, m, 0)), divisor: 3 };
    case "TRAILING_12_MONTH_AVERAGE":
      return { start: iso(utc(y, m - 12, 1)), end: iso(utc(y, m, 0)), divisor: 12 };
  }
}

export interface Comparison {
  kind: ComparisonKind;
  value: number | null;
  absolute: number | null;
  percent: number | null;
}

export function compare(
  kind: ComparisonKind,
  current: number | null,
  base: number | null,
): Comparison {
  return {
    kind,
    value: base,
    absolute: current == null || base == null ? null : current - base,
    percent: delta(current, base),
  };
}

export const ALL_COMPARISONS: ComparisonKind[] = [
  "PREVIOUS_PERIOD",
  "SAME_PERIOD_LAST_YEAR",
  "TRAILING_3_MONTH_AVERAGE",
  "TRAILING_12_MONTH_AVERAGE",
];

export type QuickWindow = "30d" | "90d" | "180d" | "12m";
export const QUICK_WINDOW_LABELS: Record<QuickWindow, string> = {
  "30d": "30 dias",
  "90d": "90 dias",
  "180d": "180 dias",
  "12m": "12 meses",
};
/** Rolling window ending at the data reference date (inclusive). */
export function quickWindowRange(w: QuickWindow, asOf: string): DateRange {
  const days = { "30d": 30, "90d": 90, "180d": 180, "12m": 365 }[w];
  const end = new Date(`${asOf}T00:00:00Z`);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: asOf, divisor: 1 };
}
