/**
 * Temporal coverage of imported data. A zero on screen must never be read as
 * "no sales" when the period simply has not been imported yet.
 */
export interface CoverageRange {
  from: string;
  to: string;
}

export type CoverageStatus = "covered" | "partial" | "none";

export interface CoverageAssessment {
  status: CoverageStatus;
  /** Loaded range that overlaps or is closest to the requested period. */
  loaded: CoverageRange | null;
  /** First and last day of the period that matter (capped at the reference date). */
  required: CoverageRange;
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** Days of the selected month that must be loaded, up to the reference date. */
export function requiredRange(period: string, asOf: string | null): CoverageRange {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  const cap = asOf && asOf >= iso(first) && asOf < iso(last) ? asOf : iso(last);
  return { from: iso(first), to: cap };
}

const nextDay = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return iso(date);
};

/** Merges touching/overlapping ranges (inputs may arrive unsorted). */
export function mergeRanges(ranges: CoverageRange[]): CoverageRange[] {
  const sorted = [...ranges]
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from.localeCompare(b.from));
  const merged: CoverageRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.from <= nextDay(last.to)) {
      if (range.to > last.to) last.to = range.to;
    } else merged.push({ ...range });
  }
  return merged;
}

export function assessCoverage(
  period: string,
  asOf: string | null,
  ranges: CoverageRange[],
): CoverageAssessment {
  const required = requiredRange(period, asOf);
  const merged = mergeRanges(ranges);
  if (!merged.length) return { status: "none", loaded: null, required };
  const full = merged.find((r) => r.from <= required.from && r.to >= required.to);
  if (full) return { status: "covered", loaded: full, required };
  const overlapping = merged.find((r) => r.from <= required.to && r.to >= required.from);
  if (overlapping) return { status: "partial", loaded: overlapping, required };
  const closest = merged.find((r) => r.from > required.to) ?? merged.at(-1) ?? null;
  return { status: "none", loaded: closest, required };
}
