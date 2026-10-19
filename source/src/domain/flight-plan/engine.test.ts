import { describe, expect, it } from "vitest";
import { DEFAULT_FLIGHT_PLAN_CONFIG as cfg, resolveConfig } from "./config";
import {
  computeFlightPlan,
  computeTimeline,
  deriveActions,
  statusFor,
  type FlightPlanInput,
} from "./engine";

const base: FlightPlanInput = {
  target: 100_000,
  realized: 40_000,
  workingDaysTotal: 20,
  workingDaysElapsed: 10,
  periodState: "current",
  portfolio: { fresh: 10_000, recent: 10_000, aged: 10_000 },
  commit: null,
};

describe("FlightPlanEngine — core formulas", () => {
  const m = computeFlightPlan(base, cfg);
  it("attainment, ideal, deviation, gap", () => {
    expect(m.attainment).toBeCloseTo(0.4);
    expect(m.idealToday).toBe(50_000);
    expect(m.deviation).toBe(-10_000);
    expect(m.remainingGap).toBe(60_000);
  });
  it("paces and run rate", () => {
    expect(m.currentDailyPace).toBe(4_000);
    expect(m.requiredDailyPace).toBe(6_000);
    expect(m.runRateForecast).toBe(80_000);
    expect(m.workingDaysRemaining).toBe(10);
  });
  it("forecasts are kept separate", () => {
    expect(m.forecastBase).toBe(50_000);
    expect(m.portfolioWeighted).toBeCloseTo(18_000);
    expect(m.forecastProbable).toBeCloseTo(58_000);
    expect(m.forecastCommit).toBeNull();
    expect(computeFlightPlan({ ...base, commit: 90_000 }, cfg).forecastCommit).toBe(90_000);
  });
  it("coverage = weighted portfolio / gap", () => {
    expect(m.gapCoverage).toBeCloseTo(0.3);
  });
  it("status uses realized / ideal", () => {
    expect(m.paceIndex).toBeCloseTo(0.8);
    expect(m.status).toBe("RISK");
  });
});

describe("FlightPlanEngine — edge cases", () => {
  it("zero elapsed days", () => {
    const m = computeFlightPlan({ ...base, realized: 0, workingDaysElapsed: 0 }, cfg);
    expect(m.idealToday).toBe(0);
    expect(m.currentDailyPace).toBeNull();
    expect(m.runRateForecast).toBeNull();
    expect(m.requiredDailyPace).toBe(5_000);
    expect(m.status).toBeNull();
  });
  it("first working day", () => {
    const m = computeFlightPlan({ ...base, realized: 5_000, workingDaysElapsed: 1 }, cfg);
    expect(m.idealToday).toBe(5_000);
    expect(m.currentDailyPace).toBe(5_000);
    expect(m.runRateForecast).toBe(100_000);
    expect(m.status).toBe("ON_TRACK");
  });
  it("last working day (zero remaining) with gap", () => {
    const m = computeFlightPlan({ ...base, realized: 90_000, workingDaysElapsed: 20 }, cfg);
    expect(m.workingDaysRemaining).toBe(0);
    expect(m.requiredDailyPace).toBeNull();
    expect(m.gapUnreachable).toBe(true);
    expect(deriveActions(m, "current", cfg)[0]?.type).toBe("GAP_UNREACHABLE");
  });
  it("zero remaining without gap", () => {
    const m = computeFlightPlan({ ...base, realized: 120_000, workingDaysElapsed: 20 }, cfg);
    expect(m.requiredDailyPace).toBe(0);
    expect(m.gapUnreachable).toBe(false);
    expect(m.gapCoverage).toBeNull();
  });
  it("zero target", () => {
    const m = computeFlightPlan({ ...base, target: 0 }, cfg);
    expect(m.attainment).toBeNull();
    expect(m.idealToday).toBeNull();
    expect(m.deviation).toBeNull();
    expect(m.remainingGap).toBe(0);
    expect(m.status).toBeNull();
    expect(deriveActions(m, "current", cfg)).toEqual([]);
  });
  it("closed period collapses forecasts to realized", () => {
    const m = computeFlightPlan(
      { ...base, periodState: "closed", realized: 92_000, workingDaysElapsed: 3 },
      cfg,
    );
    expect(m.workingDaysElapsed).toBe(20);
    expect(m.runRateForecast).toBe(92_000);
    expect(m.forecastProbable).toBe(92_000);
    expect(m.gapCoverage).toBeNull();
    expect(m.status).toBe("ATTENTION");
    expect(deriveActions(m, "closed", cfg)).toEqual([]);
  });
  it("future period", () => {
    const m = computeFlightPlan({ ...base, periodState: "future", realized: 999 }, cfg);
    expect(m.realized).toBe(0);
    expect(m.requiredDailyPace).toBe(5_000);
    expect(m.status).toBeNull();
  });
  it("zero working days in month", () => {
    const m = computeFlightPlan({ ...base, workingDaysTotal: 0, workingDaysElapsed: 0 }, cfg);
    expect(m.idealToday).toBe(0);
    expect(m.requiredDailyPace).toBeNull();
  });
});

describe("status thresholds", () => {
  it("bands", () => {
    expect(statusFor(1.0, cfg)).toBe("ON_TRACK");
    expect(statusFor(0.97, cfg)).toBe("ON_TRACK");
    expect(statusFor(0.93, cfg)).toBe("ATTENTION");
    expect(statusFor(0.8, cfg)).toBe("RISK");
    expect(statusFor(0.5, cfg)).toBe("CRITICAL");
    expect(statusFor(null, cfg)).toBeNull();
  });
  it("config merge keeps defaults and accepts overrides", () => {
    const c = resolveConfig({ status: { onTrack: 0.99 }, activeLevel: "CHALLENGE" });
    expect(c.status.onTrack).toBe(0.99);
    expect(c.status.risk).toBe(0.75);
    expect(c.activeLevel).toBe("CHALLENGE");
    expect(resolveConfig({ activeLevel: "BOGUS" }).activeLevel).toBe("ACTIVE");
  });
});

describe("actions", () => {
  it("fires deterministic rules", () => {
    const m = computeFlightPlan(base, cfg);
    const types = deriveActions(m, "current", cfg).map((a) => a.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "BELOW_FLIGHT_LINE",
        "GAP_OPEN",
        "LOW_COVERAGE",
        "PACE_ACCELERATION",
        "NEW_PIPELINE",
      ]),
    );
  });
});

describe("timeline", () => {
  it("cumulative, ideal and projection", () => {
    const days = [
      { date: "2026-10-01", working: true, revenue: 10 },
      { date: "2026-10-02", working: true, revenue: 30 },
      { date: "2026-10-03", working: false, revenue: null },
      { date: "2026-10-04", working: true, revenue: null },
    ];
    const m = computeFlightPlan(
      {
        ...base,
        target: 90,
        realized: 40,
        workingDaysTotal: 3,
        workingDaysElapsed: 2,
        portfolio: { fresh: 0, recent: 0, aged: 0 },
      },
      cfg,
    );
    const t = computeTimeline(days, m, "2026-10-02", "current");
    expect(t.map((p) => p.realizedCumulative)).toEqual([10, 40, null, null]);
    expect(t.map((p) => p.idealCumulative)).toEqual([30, 60, 60, 90]);
    expect(t[3]!.projection).toBe(60);
    expect(t[1]!.isToday).toBe(true);
  });
});
