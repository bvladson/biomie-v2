/**
 * Deterministic RFM (Recency, Frequency, Monetary) — no AI, no churn prediction.
 * Scores 1..5 per dimension using CONFIGURABLE fixed bands (ascending cut points).
 * Inputs (all as of data_as_of): recency = days since last purchase,
 * frequency = invoices in last 12 months, monetary = revenue in last 12 months.
 * Live values may come from metric_config key "rfm" and are merged over defaults.
 */
export interface RfmConfig {
  /** Days; lower is better. 4 cut points → 5 bands. */
  recency: [number, number, number, number];
  /** Invoices in 12m; higher is better. */
  frequency: [number, number, number, number];
  /** Revenue in 12m (BRL); higher is better. */
  monetary: [number, number, number, number];
}

export const DEFAULT_RFM_CONFIG: RfmConfig = {
  recency: [30, 60, 120, 240],
  frequency: [2, 4, 8, 12],
  monetary: [20_000, 60_000, 150_000, 300_000],
};

export function resolveRfmConfig(raw: unknown): RfmConfig {
  const r = (raw ?? {}) as Partial<RfmConfig>;
  const ok = (v: unknown): v is [number, number, number, number] =>
    Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number");
  return {
    recency: ok(r.recency) ? r.recency : DEFAULT_RFM_CONFIG.recency,
    frequency: ok(r.frequency) ? r.frequency : DEFAULT_RFM_CONFIG.frequency,
    monetary: ok(r.monetary) ? r.monetary : DEFAULT_RFM_CONFIG.monetary,
  };
}

/** Higher value → higher score (frequency, monetary). value < cut[0] → 1, ≥ cut[3] → 5. */
function scoreUp(v: number, cuts: number[]): number {
  return 1 + cuts.filter((c) => v >= c).length;
}
/** Lower value → higher score (recency). value ≤ cut[0] → 5, > cut[3] → 1. */
function scoreDown(v: number, cuts: number[]): number {
  return 5 - cuts.filter((c) => v > c).length;
}

export type RfmSegment =
  "CHAMPIONS" | "LOYAL" | "POTENTIAL" | "NEW" | "AT_RISK" | "HIBERNATING" | "LOST";

export const RFM_SEGMENT_LABELS: Record<RfmSegment, string> = {
  CHAMPIONS: "Campeões",
  LOYAL: "Leais",
  POTENTIAL: "Potenciais",
  NEW: "Novos",
  AT_RISK: "Em risco",
  HIBERNATING: "Hibernando",
  LOST: "Perdidos",
};

export interface RfmResult {
  r: number;
  f: number;
  m: number;
  code: string;
  segment: RfmSegment;
}

export function computeRfm(
  input: { recencyDays: number | null; frequency: number; monetary: number; isNew?: boolean },
  cfg: RfmConfig = DEFAULT_RFM_CONFIG,
): RfmResult | null {
  if (input.recencyDays == null) return null;
  const r = scoreDown(input.recencyDays, cfg.recency);
  const f = scoreUp(input.frequency, cfg.frequency);
  const m = scoreUp(input.monetary, cfg.monetary);
  let segment: RfmSegment;
  if (r >= 4 && f >= 4 && m >= 4) segment = "CHAMPIONS";
  else if (input.isNew && r >= 4) segment = "NEW";
  else if (r >= 3 && f >= 3) segment = "LOYAL";
  else if (r >= 4) segment = "POTENTIAL";
  else if (r === 3 || (r === 2 && f >= 3)) segment = "AT_RISK";
  else if (r === 2) segment = "HIBERNATING";
  else segment = "LOST";
  return { r, f, m, code: `${r}${f}${m}`, segment };
}
