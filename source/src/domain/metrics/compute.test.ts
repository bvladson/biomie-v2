import { describe, expect, it } from "vitest";
import { attainment, dailyRequired, delta, forecastLinear } from "./compute";

describe("metric compute", () => {
  it("attainment handles zero target", () => {
    expect(attainment(100, 0)).toBeNull();
    expect(attainment(50, 200)).toBe(0.25);
  });
  it("forecast is linear by working days in current month", () => {
    expect(forecastLinear(1000, 10, 20, true, false)).toBe(2000);
    expect(forecastLinear(1000, 10, 20, false, false)).toBe(1000);
    expect(forecastLinear(1000, 0, 20, false, true)).toBeNull();
  });
  it("daily required never negative", () => {
    expect(dailyRequired(1200, 1000, 5, 20)).toBe(0);
    expect(dailyRequired(500, 1000, 15, 20)).toBe(100);
  });
  it("delta", () => {
    expect(delta(110, 100)).toBeCloseTo(0.1);
    expect(delta(10, 0)).toBeNull();
  });
});
