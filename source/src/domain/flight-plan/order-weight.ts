/**
 * OrderWeightModel — the ONLY place an open order's forecast weight is decided.
 *
 * PROVISIONAL RULE (demo mode): weight depends only on the order age
 * (0–15 days → 90%, 16–45 → 60%, >45 → 30%; cut-offs and weights come from
 * metric_config.flight_plan). When the real Omie integration lands, the extra
 * fields below (status, stage, expected billing date…) will feed this model
 * without changing callers.
 */
import type { FlightPlanConfig } from "./config";
import type { PortfolioBuckets } from "./engine";

export type AgeBucket = keyof PortfolioBuckets; // "fresh" | "recent" | "aged"

export interface OrderWeightInput {
  ageDays: number;
  total: number;
  /** Future inputs (ignored by the provisional rule). */
  status?: string | null;
  stage?: string | null;
  expectedDate?: string | null;
}

export interface OrderWeight {
  bucket: AgeBucket;
  /** Probability applied in Forecast Provável and weighted portfolio. */
  weight: number;
  /** Counts in Forecast Base (only fresh orders). */
  inForecastBase: boolean;
  /** Every open order counts in Carteira. */
  inPortfolio: true;
  weighted: number;
}

export const ORDER_WEIGHT_RULE_IS_PROVISIONAL = true;

export function ageBucket(ageDays: number, cfg: FlightPlanConfig): AgeBucket {
  if (ageDays <= cfg.ageBuckets.freshMaxDays) return "fresh";
  if (ageDays <= cfg.ageBuckets.recentMaxDays) return "recent";
  return "aged";
}

export function weighOrder(o: OrderWeightInput, cfg: FlightPlanConfig): OrderWeight {
  const bucket = ageBucket(o.ageDays, cfg);
  const weight = cfg.probableWeights[bucket];
  return {
    bucket,
    weight,
    inForecastBase: bucket === "fresh",
    inPortfolio: true,
    weighted: o.total * weight,
  };
}

/** Aggregate open orders into the buckets consumed by computeFlightPlan. */
export function bucketOrders(
  orders: OrderWeightInput[],
  cfg: FlightPlanConfig,
): PortfolioBuckets & { orders: number } {
  const out = { fresh: 0, recent: 0, aged: 0, orders: orders.length };
  for (const o of orders) out[ageBucket(o.ageDays, cfg)] += o.total;
  return out;
}
