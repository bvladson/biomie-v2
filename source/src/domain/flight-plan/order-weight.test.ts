import { describe, expect, it } from "vitest";
import { DEFAULT_FLIGHT_PLAN_CONFIG as cfg } from "./config";
import { weighOrder } from "./order-weight";

describe("OrderWeightModel", () => {
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
  it("expected billing date already passed: late, 30%, out of the base forecast (D3)", () => {
    const w = weighOrder({ ageDays: 3, total: 100, expectedDate: "2026-11-01" }, cfg, {
      today: "2026-11-04",
    });
    expect(w).toMatchObject({ late: true, weight: 0.3, inForecastBase: false, weighted: 30 });
  });
  it("expected after the period end: weight 0 for this period", () => {
    const w = weighOrder({ ageDays: 3, total: 100, expectedDate: "2026-12-02" }, cfg, {
      today: "2026-11-04",
      periodEnd: "2026-11-30",
    });
    expect(w).toMatchObject({ late: false, outOfPeriod: true, weight: 0, inForecastBase: false });
  });
  it("without reference dates only the age counts", () => {
    expect(weighOrder({ ageDays: 3, total: 100, expectedDate: "2020-01-01" }, cfg).late).toBe(
      false,
    );
  });
});
