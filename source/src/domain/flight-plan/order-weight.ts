/**
 * OrderWeightModel — the ONLY place an open order's forecast weight is decided.
 *
 * Rules (cut-offs and weights come from metric_config.flight_plan):
 * - expected billing date already passed → LATE, weight = lateOrderWeight (D3, 30%), alert;
 * - expected billing date after the period end → outside the period, weight 0;
 * - otherwise by age: 0–15 days fresh (90%), 16–45 recent (60%), older aged (30%).
 * Quotes (Omie stage 10) are not orders: they are listed apart and never weighted (D4).
 * The weights were decided, not calibrated: keep the flag until a calibration exists.
 */
import type { FlightPlanConfig } from "./config";

export type AgeBucket = "fresh" | "recent" | "aged";

export interface OrderWeightInput {
  ageDays: number;
  total: number;
  status?: string | null;
  stage?: string | null;
  expectedDate?: string | null;
}

/** Reference dates: `today` enables the late rule, `periodEnd` the outside-the-period rule. */
export interface OrderWeightContext {
  today?: string;
  periodEnd?: string;
}

export interface OrderWeight {
  bucket: AgeBucket;
  /** Probability applied in Forecast Provável and weighted portfolio. */
  weight: number;
  late: boolean;
  outOfPeriod: boolean;
  /** Counts in Forecast Base (fresh, on time, inside the period). */
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

export function weighOrder(
  o: OrderWeightInput,
  cfg: FlightPlanConfig,
  ctx: OrderWeightContext = {},
): OrderWeight {
  const bucket = ageBucket(o.ageDays, cfg);
  const late = !!(ctx.today && o.expectedDate && o.expectedDate < ctx.today);
  const outOfPeriod =
    !late && !!(ctx.periodEnd && o.expectedDate && o.expectedDate > ctx.periodEnd);
  const weight = late ? cfg.lateOrderWeight : outOfPeriod ? 0 : cfg.probableWeights[bucket];
  return {
    bucket,
    weight,
    late,
    outOfPeriod,
    inForecastBase: bucket === "fresh" && !late && !outOfPeriod,
    inPortfolio: true,
    weighted: o.total * weight,
  };
}
