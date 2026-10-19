import { describe, expect, it } from "vitest";
import { DEFAULT_FLIGHT_PLAN_CONFIG as cfg } from "./config";
import { bucketOrders, weighOrder } from "./order-weight";

describe("OrderWeightModel (provisional)", () => {
  it("applies 90/60/30 by age with boundaries", () => {
    expect(weighOrder({ ageDays: 15, total: 100 }, cfg)).toMatchObject({
      bucket: "fresh",
      weight: 0.9,
      inForecastBase: true,
      weighted: 90,
    });
    expect(weighOrder({ ageDays: 16, total: 100 }, cfg)).toMatchObject({
      bucket: "recent",
      weight: 0.6,
      inForecastBase: false,
    });
    expect(weighOrder({ ageDays: 46, total: 100 }, cfg).weight).toBe(0.3);
  });
  it("aggregates buckets", () => {
    expect(
      bucketOrders(
        [
          { ageDays: 1, total: 10 },
          { ageDays: 30, total: 5 },
          { ageDays: 90, total: 2 },
        ],
        cfg,
      ),
    ).toEqual({ fresh: 10, recent: 5, aged: 2, orders: 3 });
  });
});
