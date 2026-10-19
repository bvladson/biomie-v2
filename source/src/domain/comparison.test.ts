import { describe, expect, it } from "vitest";
import { compare, comparisonRange, periodRange } from "./comparison";

describe("PeriodComparisonService", () => {
  it("cuts the current month at asOf", () => {
    expect(periodRange("2026-10", "2026-10-02")).toMatchObject({
      start: "2026-10-01",
      end: "2026-10-02",
      state: "current",
    });
    expect(periodRange("2026-09", "2026-10-02")).toMatchObject({
      end: "2026-09-30",
      state: "closed",
    });
    expect(periodRange("2026-11", "2026-10-02").state).toBe("future");
  });
  it("uses the same cut for previous period and last year while open", () => {
    expect(comparisonRange("PREVIOUS_PERIOD", "2026-10", "2026-10-02")).toMatchObject({
      start: "2026-09-01",
      end: "2026-09-02",
    });
    expect(comparisonRange("SAME_PERIOD_LAST_YEAR", "2026-10", "2026-10-02")).toMatchObject({
      start: "2025-10-01",
      end: "2025-10-02",
    });
  });
  it("clamps day to shorter months and uses full months when closed", () => {
    expect(comparisonRange("PREVIOUS_PERIOD", "2026-03", "2026-03-31").end).toBe("2026-02-28");
    expect(comparisonRange("PREVIOUS_PERIOD", "2026-09", "2026-10-02").end).toBe("2026-08-31");
  });
  it("trailing averages cover full prior months with a divisor", () => {
    expect(comparisonRange("TRAILING_3_MONTH_AVERAGE", "2026-01", "2026-01-10")).toEqual({
      start: "2025-10-01",
      end: "2025-12-31",
      divisor: 3,
    });
    expect(comparisonRange("TRAILING_12_MONTH_AVERAGE", "2026-10", "2026-10-02").divisor).toBe(12);
  });
  it("computes absolute and percent variation", () => {
    expect(compare("PREVIOUS_PERIOD", 120, 100)).toMatchObject({ absolute: 20, percent: 0.2 });
    expect(compare("PREVIOUS_PERIOD", 120, 0).percent).toBeNull();
  });
});
