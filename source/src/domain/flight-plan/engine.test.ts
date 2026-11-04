import { describe, expect, it } from "vitest";
import type { CalendarDay } from "@/flight-plan/api/contract";
import { DEFAULT_FLIGHT_PLAN_CONFIG as cfg, resolveConfig, saturdayWeightFor } from "./config";
import {
  buildTimeline,
  buildYearRows,
  companyTargetSet,
  computeAlerts,
  computeMetrics,
  conversionStatus,
  deriveActions,
  noTargetEvidence,
  partialPeriod,
  remainingWorkdays,
  statusFromRatio,
  toLegacyMetrics,
  toLegacyTimeline,
  type MetricsInput,
  type OpenOrder,
} from "./engine";

/** October/2026 reduced to 20 working days (1st to 20th) to keep the arithmetic readable. */
const calendar: CalendarDay[] = Array.from({ length: 31 }, (_, i) => {
  const day = String(i + 1).padStart(2, "0");
  return { date: `2026-10-${day}`, weight: i < 20 ? 1 : 0, holiday: null };
});
const order = (
  id: string,
  amount: number,
  openedAt: string,
  expectedDate: string | null = null,
): OpenOrder => ({
  id,
  sellerId: "s1",
  amount,
  openedAt,
  expectedDate,
});
const base: MetricsInput = {
  target: 100_000,
  realized: 40_000,
  calendar,
  today: "2026-10-10",
  month: "2026-10",
  orders: [
    order("fresh", 10_000, "2026-10-05"),
    order("recent", 10_000, "2026-09-10"),
    order("aged", 10_000, "2026-08-01"),
  ],
  commits: [],
};

describe("FlightPlanEngine — core formulas", () => {
  const m = computeMetrics(base, cfg);
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
    expect(m.workdaysRemaining).toBe(10);
  });
  it("forecasts are kept separate", () => {
    expect(m.forecastBase).toBe(50_000);
    expect(m.portfolioWeighted).toBeCloseTo(18_000);
    expect(m.forecastProbable).toBeCloseTo(58_000);
    expect(m.forecastCommit).toBeNull();
    expect(computeMetrics({ ...base, commits: [60_000, 30_000] }, cfg).forecastCommit).toBe(90_000);
  });
  it("coverage = weighted portfolio / gap", () => {
    expect(m.gapCoverage).toBeCloseTo(0.3);
  });
  it("status uses realized / ideal", () => {
    expect(toLegacyMetrics(m, "current").paceIndex).toBeCloseTo(0.8);
    expect(m.status).toBe("RISK");
  });
});

describe("FlightPlanEngine — orders by expected date (D3)", () => {
  it("expected date already passed: late, weighs 30% and is not in the base forecast", () => {
    const m = computeMetrics(
      { ...base, orders: [order("late", 10_000, "2026-10-08", "2026-10-09")] },
      cfg,
    );
    expect(m.lateOrdersAmount).toBe(10_000);
    expect(m.portfolioWeighted).toBe(3_000);
    expect(m.forecastBase).toBe(40_000);
  });
  it("expected after the month: in the portfolio, not in this month's forecast", () => {
    const m = computeMetrics(
      { ...base, orders: [order("next", 10_000, "2026-10-08", "2026-11-03")] },
      cfg,
    );
    expect(m.portfolio).toBe(10_000);
    expect(m.portfolioWeighted).toBe(0);
    expect(m.lateOrdersAmount).toBe(0);
  });
  it("late weight comes from the configuration", () => {
    const c = resolveConfig({ lateOrderWeight: 0.5 });
    const m = computeMetrics(
      { ...base, orders: [order("late", 10_000, "2026-10-08", "2026-10-09")] },
      c,
    );
    expect(m.portfolioWeighted).toBe(5_000);
  });
});

describe("FlightPlanEngine — edge cases", () => {
  it("first working day", () => {
    const m = computeMetrics({ ...base, today: "2026-10-01", realized: 5_000 }, cfg);
    expect(m.workdaysElapsed).toBe(1);
    expect(m.idealToday).toBe(5_000);
    expect(m.status).toBe("ON_TRACK");
  });
  it("last working day (zero remaining) with gap", () => {
    const m = computeMetrics({ ...base, today: "2026-10-25" }, cfg);
    expect(m.workdaysRemaining).toBe(0);
    expect(m.gapUnreachable).toBe(true);
    expect(m.requiredDailyPace).toBeNull();
  });
  it("no target: no ideal, no status", () => {
    const m = computeMetrics({ ...base, target: null }, cfg);
    expect(m.idealToday).toBeNull();
    expect(m.remainingGap).toBeNull();
    expect(m.attainment).toBeNull();
    expect(m.status).toBeNull();
  });
  it("closed period collapses forecasts to realized", () => {
    const m = computeMetrics({ ...base, today: "2026-11-04", realized: 98_000 }, cfg);
    expect(m.workdaysElapsed).toBe(20);
    expect(m.forecastBase).toBe(98_000);
    expect(m.forecastProbable).toBe(98_000);
    expect(m.runRateForecast).toBe(98_000);
    expect(m.portfolio).toBe(0);
    expect(m.status).toBe("ON_TRACK");
  });
  it("future period", () => {
    const m = computeMetrics({ ...base, today: "2026-09-20", realized: 0 }, cfg);
    expect(m.workdaysElapsed).toBe(0);
    expect(m.currentDailyPace).toBeNull();
    expect(m.requiredDailyPace).toBe(5_000);
    expect(m.status).toBeNull();
  });
  it("month without working days", () => {
    const empty = calendar.map((d) => ({ ...d, weight: 0 }));
    const m = computeMetrics({ ...base, calendar: empty }, cfg);
    expect(m.idealToday).toBeNull();
    expect(m.gapUnreachable).toBe(true);
  });
});

describe("status thresholds and configuration", () => {
  it("bands", () => {
    expect(statusFromRatio(0.97, cfg)).toBe("ON_TRACK");
    expect(statusFromRatio(0.9, cfg)).toBe("ATTENTION");
    expect(statusFromRatio(0.75, cfg)).toBe("RISK");
    expect(statusFromRatio(0.5, cfg)).toBe("CRITICAL");
    expect(statusFromRatio(null, cfg)).toBeNull();
  });
  it("config merge keeps defaults and accepts overrides", () => {
    const c = resolveConfig({ status: { onTrack: 0.99 }, activeLevel: "CHALLENGE" });
    expect(c.status.onTrack).toBe(0.99);
    expect(c.status.risk).toBe(0.75);
    expect(c.activeLevel).toBe("CHALLENGE");
    expect(resolveConfig({ activeLevel: "BOGUS" }).activeLevel).toBe("ACTIVE");
    expect(resolveConfig({ status: { onTrack: "x" } }).status.onTrack).toBe(0.97);
  });
  it("Saturday weight per company (D2), default for the others", () => {
    const c = resolveConfig({
      saturdayWeights: { "mag-filial": 0.33, ruim: 3 },
      saturdayWeightDefault: 0,
    });
    expect(saturdayWeightFor(c, "mag-filial")).toBe(0.33);
    expect(saturdayWeightFor(c, "ergooffice")).toBe(0);
    expect(saturdayWeightFor(c, "ruim")).toBe(0);
  });
  it("alert thresholds follow the legacy acceleration when not configured", () => {
    expect(resolveConfig({ accelerationAlert: 0.3 }).alerts.paceAcceleration).toBe(0.3);
    expect(
      resolveConfig({ accelerationAlert: 0.3, alerts: { paceAcceleration: 0.25 } }).alerts
        .paceAcceleration,
    ).toBe(0.25);
  });
});

describe("company target (D1)", () => {
  const rows = [
    { channel: "varejo", level: "ACTIVE" as const, amount: 600 },
    { channel: "licitacao", level: "ACTIVE" as const, amount: 400 },
  ];
  it("channel row, else whole company, else channels summed", () => {
    expect(companyTargetSet(rows, "varejo").ACTIVE).toBe(600);
    expect(companyTargetSet(rows).ACTIVE).toBe(1_000);
    expect(
      companyTargetSet([...rows, { channel: null, level: "ACTIVE", amount: 900 }]).ACTIVE,
    ).toBe(900);
    expect(companyTargetSet(rows).BASE).toBeNull();
  });
});

describe("quarter, year and conversion", () => {
  it("only months with a target count for % and pace", () => {
    const p = partialPeriod([
      { month: "2026-10", target: null, realized: 600, workdaysRemaining: 0 },
      { month: "2026-11", target: 700, realized: 400, workdaysRemaining: 7.66 },
      { month: "2026-12", target: null, realized: 0, workdaysRemaining: 21 },
    ]);
    expect(p.missingTarget).toBe(2);
    expect(p.attainment).toBeCloseTo(400 / 700);
    expect(p.requiredDailyPace).toBeCloseTo(300 / 7.66, 1);
    expect(p.realizedTotal).toBe(1_000);
  });
  it("remaining working days: 0 when closed, all when future", () => {
    expect(remainingWorkdays(calendar, "2026-10", "2026-11-04")).toBe(0);
    expect(remainingWorkdays(calendar, "2026-10", "2026-09-01")).toBe(20);
    expect(remainingWorkdays(calendar, "2026-10", "2026-10-10")).toBe(10);
  });
  it("year rows accumulate from the first month with a target", () => {
    const rows = buildYearRows([
      { month: "2026-01", target: null, realized: 10 },
      { month: "2026-02", target: 100, realized: 90 },
    ]);
    expect(rows[0]!.cumulativeTarget).toBeNull();
    expect(rows[1]!.cumulativeTarget).toBe(100);
    expect(rows[1]!.cumulativeRealized).toBe(100);
  });
  it("conversion is 'forming' until enough history", () => {
    const c = resolveConfig({ conversion: { since: "2026-11-04", minDays: 60, minResolved: 20 } });
    const facts = {
      tracked: 58,
      trackedAmount: 1,
      converted: 15,
      convertedAmount: 1,
      lost: 10,
      lostAmount: 1,
    };
    expect(conversionStatus(facts, "2026-11-20", c).status).toBe("forming");
    const ready = conversionStatus(facts, "2027-01-10", c);
    expect(ready.status).toBe("ready");
    expect(ready.rateCount).toBeCloseTo(0.6);
  });
});

describe("legacy shape (Vendedores, Vendedor 360)", () => {
  it("actions fire on the same numbers", () => {
    const m = toLegacyMetrics(computeMetrics(base, cfg), "current");
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
  it("timeline: cumulative, ideal and projection", () => {
    const cal: CalendarDay[] = [
      { date: "2026-10-01", weight: 1, holiday: null },
      { date: "2026-10-02", weight: 1, holiday: null },
      { date: "2026-10-03", weight: 0, holiday: null },
      { date: "2026-10-04", weight: 1, holiday: null },
    ];
    const daily = new Map([
      ["2026-10-01", 10],
      ["2026-10-02", 30],
    ]);
    const m = computeMetrics(
      { ...base, calendar: cal, target: 90, realized: 40, today: "2026-10-02", orders: [] },
      cfg,
    );
    const t = toLegacyTimeline(buildTimeline(cal, daily, m, "2026-10-02"));
    expect(t.map((p) => p.realizedCumulative)).toEqual([10, 40, null, null]);
    expect(t.map((p) => p.idealCumulative)).toEqual([30, 60, 60, 90]);
    expect(t.map((p) => p.working)).toEqual([true, true, false, true]);
    expect(t[3]!.projection).toBe(60);
    expect(t[1]!.isToday).toBe(true);
  });
});

describe("alert NO_TARGET (month without target) by scope", () => {
  it("says what is missing for the company, a channel, a team, a person without sellers and one seller", () => {
    expect(noTargetEvidence("empresa", 4)).toBe("Meta da empresa e dos vendedores vazias");
    expect(noTargetEvidence("empresa~1abc", 4)).toBe("Meta da empresa e dos vendedores vazias");
    expect(noTargetEvidence("empresa-varejo", 3)).toBe(
      "Meta do canal e dos vendedores do canal vazias",
    );
    expect(noTargetEvidence("escopo-u1", 2)).toBe("Nenhum vendedor do seu escopo tem meta no mês");
    expect(noTargetEvidence("escopo-u1-varejo", 0)).toMatch(/^Nenhum vendedor no seu escopo: peça/);
    expect(noTargetEvidence("filtro-s1", 1)).toBe("Este vendedor não tem meta no mês");
  });

  it("computeAlerts uses the scope of the reading (key and text)", () => {
    const [a] = computeAlerts(
      {
        companyId: "c",
        month: "2026-11",
        noTarget: true,
        calendarMissingYear: null,
        aggregateSubject: "escopo-u1",
      },
      [],
    );
    expect(a).toMatchObject({
      type: "NO_TARGET",
      key: "NO_TARGET:c:escopo-u1:2026-11",
      sellerId: null,
    });
    expect(a!.evidence).toMatch(/^Nenhum vendedor no seu escopo/);
  });
});
