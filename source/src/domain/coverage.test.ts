import { describe, expect, it } from "vitest";
import { assessCoverage, mergeRanges, requiredRange } from "./coverage";

describe("data coverage", () => {
  it("caps the current month at the reference date", () => {
    expect(requiredRange("2026-10", "2026-10-19")).toEqual({
      from: "2026-10-01",
      to: "2026-10-19",
    });
    expect(requiredRange("2026-09", "2026-10-19")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("merges adjacent and overlapping loads", () => {
    expect(
      mergeRanges([
        { from: "2026-03-01", to: "2026-03-31" },
        { from: "2026-01-01", to: "2026-02-28" },
        { from: "2026-03-15", to: "2026-04-10" },
      ]),
    ).toEqual([{ from: "2026-01-01", to: "2026-04-10" }]);
  });

  it("distinguishes covered, partial and not imported periods", () => {
    const loaded = [{ from: "2026-01-01", to: "2026-10-19" }];
    expect(assessCoverage("2026-10", "2026-10-19", loaded).status).toBe("covered");
    expect(assessCoverage("2026-05", "2026-10-19", loaded).status).toBe("covered");
    expect(assessCoverage("2025-12", "2026-10-19", loaded).status).toBe("none");
    expect(
      assessCoverage("2026-10", "2026-10-25", [{ from: "2026-01-01", to: "2026-10-19" }]).status,
    ).toBe("partial");
    expect(assessCoverage("2026-10", "2026-10-19", []).status).toBe("none");
  });
});
