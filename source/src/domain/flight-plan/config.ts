/**
 * Flight Plan configuration. Defaults below are DEMO criteria; the live values
 * come from metric_config (key "flight_plan") and are merged over these.
 * Thresholds are CONFIGURABLE — never hard-code them in components.
 */
export type TargetLevel = "BASE" | "ACTIVE" | "CHALLENGE";

export interface FlightPlanConfig {
  activeLevel: TargetLevel;
  /** Status by ratio realized / ideal (current) or realized / target (closed). */
  status: { onTrack: number; attention: number; risk: number };
  /** Open-order age buckets (days since order date). */
  ageBuckets: { freshMaxDays: number; recentMaxDays: number };
  /** Weights applied to open orders for Forecast Provável. */
  probableWeights: { fresh: number; recent: number; aged: number };
  /** Alert when required pace exceeds current pace by more than this fraction. */
  accelerationAlert: number;
}

export const DEFAULT_FLIGHT_PLAN_CONFIG: FlightPlanConfig = {
  activeLevel: "ACTIVE",
  status: { onTrack: 0.97, attention: 0.9, risk: 0.75 },
  ageBuckets: { freshMaxDays: 15, recentMaxDays: 45 },
  probableWeights: { fresh: 0.9, recent: 0.6, aged: 0.3 },
  accelerationAlert: 0.2,
};

export function resolveConfig(raw: unknown): FlightPlanConfig {
  const r = (raw ?? {}) as Partial<FlightPlanConfig>;
  const d = DEFAULT_FLIGHT_PLAN_CONFIG;
  const level =
    r.activeLevel && ["BASE", "ACTIVE", "CHALLENGE"].includes(r.activeLevel)
      ? r.activeLevel
      : d.activeLevel;
  return {
    activeLevel: level,
    status: { ...d.status, ...(r.status ?? {}) },
    ageBuckets: { ...d.ageBuckets, ...(r.ageBuckets ?? {}) },
    probableWeights: { ...d.probableWeights, ...(r.probableWeights ?? {}) },
    accelerationAlert:
      typeof r.accelerationAlert === "number" ? r.accelerationAlert : d.accelerationAlert,
  };
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
