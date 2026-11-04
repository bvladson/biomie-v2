/**
 * Flight Plan configuration. Defaults below are DEMO criteria; the live values
 * come from metric_config (key "flight_plan") and are merged over these.
 * Thresholds are CONFIGURABLE — never hard-code them in components.
 */
export type TargetLevel = "BASE" | "ACTIVE" | "CHALLENGE";

export interface FlightPlanAlertConfig {
  /** Weighted portfolio + planned initiatives below this share of the gap → LOW_COVERAGE. */
  lowCoverage: number;
  /** Required pace above current pace by more than this fraction → PACE_ACCELERATION. */
  paceAcceleration: number;
  /** Open quotes older than this (days) → STALE_QUOTES. */
  staleQuoteDays: number;
  /** Seller with target and no invoice for this many working days → SELLER_IDLE. */
  idleSellerWorkdays: number;
}

export interface FlightPlanConfig {
  activeLevel: TargetLevel;
  /** Status by ratio realized / ideal (current) or realized / target (closed). */
  status: { onTrack: number; attention: number; risk: number };
  /** Open-order age buckets (days since order date). */
  ageBuckets: { freshMaxDays: number; recentMaxDays: number };
  /** Weights applied to open orders for Forecast Provável. */
  probableWeights: { fresh: number; recent: number; aged: number };
  /** Weight of an open order whose expected billing date already passed (D3). */
  lateOrderWeight: number;
  /** Legacy actions (Vendedor 360): required pace above current pace by more than this. */
  accelerationAlert: number;
  /** Saturday weight per company slug (D2); companies not listed use saturdayWeightDefault. */
  saturdayWeights: Record<string, number>;
  saturdayWeightDefault: number;
  alerts: FlightPlanAlertConfig;
  /** Quote conversion: tracked since `since` (stage history); "ready" after minDays and minResolved. */
  conversion: { since: string | null; minDays: number; minResolved: number };
  /** Route target lists: inactive customer threshold, look-back window and item cap. */
  targetLists: { inactiveDays: number; lookbackDays: number; maxItems: number };
}

export const DEFAULT_FLIGHT_PLAN_CONFIG: FlightPlanConfig = {
  activeLevel: "ACTIVE",
  status: { onTrack: 0.97, attention: 0.9, risk: 0.75 },
  ageBuckets: { freshMaxDays: 15, recentMaxDays: 45 },
  probableWeights: { fresh: 0.9, recent: 0.6, aged: 0.3 },
  lateOrderWeight: 0.3,
  accelerationAlert: 0.2,
  saturdayWeights: {},
  saturdayWeightDefault: 0,
  alerts: { lowCoverage: 0.5, paceAcceleration: 0.2, staleQuoteDays: 15, idleSellerWorkdays: 5 },
  conversion: { since: null, minDays: 60, minResolved: 20 },
  targetLists: { inactiveDays: 90, lookbackDays: 365, maxItems: 200 },
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown, fallback: number) => (isNum(v) ? v : fallback);
/** Merge only the numeric keys of `base` that `raw` provides as finite numbers. */
function mergeNumbers<T extends Record<string, number>>(base: T, raw: unknown): T {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, number> = { ...base };
  for (const k of Object.keys(base)) out[k] = num(r[k], base[k] as number);
  return out as T;
}

export function resolveConfig(raw: unknown): FlightPlanConfig {
  const r = (raw ?? {}) as Partial<Record<keyof FlightPlanConfig, unknown>>;
  const d = DEFAULT_FLIGHT_PLAN_CONFIG;
  const level =
    typeof r.activeLevel === "string" && ["BASE", "ACTIVE", "CHALLENGE"].includes(r.activeLevel)
      ? (r.activeLevel as TargetLevel)
      : d.activeLevel;
  const accelerationAlert = num(r.accelerationAlert, d.accelerationAlert);
  const saturdayWeights: Record<string, number> = {};
  if (r.saturdayWeights && typeof r.saturdayWeights === "object")
    for (const [slug, w] of Object.entries(r.saturdayWeights as Record<string, unknown>))
      if (isNum(w) && w >= 0 && w <= 1) saturdayWeights[slug] = w;
  const conv = (r.conversion ?? {}) as Record<string, unknown>;
  const rawSince = conv["since"];
  const since =
    typeof rawSince === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawSince) ? rawSince : null;
  return {
    activeLevel: level,
    status: mergeNumbers(d.status, r.status),
    ageBuckets: mergeNumbers(d.ageBuckets, r.ageBuckets),
    probableWeights: mergeNumbers(d.probableWeights, r.probableWeights),
    lateOrderWeight: num(r.lateOrderWeight, d.lateOrderWeight),
    accelerationAlert,
    saturdayWeights,
    saturdayWeightDefault: num(r.saturdayWeightDefault, d.saturdayWeightDefault),
    alerts: mergeNumbers({ ...d.alerts, paceAcceleration: accelerationAlert }, r.alerts),
    conversion: {
      since,
      minDays: num(conv["minDays"], d.conversion.minDays),
      minResolved: num(conv["minResolved"], d.conversion.minResolved),
    },
    targetLists: mergeNumbers(d.targetLists, r.targetLists),
  };
}

/** Saturday weight of a company (D2): configured by slug, else the default. */
export function saturdayWeightFor(cfg: FlightPlanConfig, slug: string): number {
  return cfg.saturdayWeights[slug] ?? cfg.saturdayWeightDefault;
}

export const TARGET_LEVEL_LABELS: Record<TargetLevel, string> = {
  BASE: "Meta Base",
  ACTIVE: "Meta Ativa",
  CHALLENGE: "Meta Desafio",
};

export type FlightStatus = "ON_TRACK" | "ATTENTION" | "RISK" | "CRITICAL";

export const STATUS_META: Record<
  FlightStatus,
  { label: string; tone: "success" | "warning" | "risk" | "destructive"; symbol: string }
> = {
  ON_TRACK: { label: "No plano", tone: "success", symbol: "▲" },
  ATTENTION: { label: "Atenção", tone: "warning", symbol: "●" },
  RISK: { label: "Em risco", tone: "risk", symbol: "▼" },
  CRITICAL: { label: "Crítico", tone: "destructive", symbol: "✖" },
};
