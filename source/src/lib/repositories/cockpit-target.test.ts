import { describe, expect, it } from "vitest";
import { fetchCockpit } from "./analytics.repository.server";

const aggregate = { revenue: 405151.25, invoices: 141, customers: 120, units: 300 };

function raw(target: number | null) {
  return {
    period: {
      start: "2026-10-01",
      end: "2026-10-31",
      cut: "2026-10-20",
      isCurrent: true,
      isFuture: false,
    },
    comparison: {
      previousMonth: { start: "2026-09-01", end: "2026-09-20" },
      previousYear: { start: "2025-10-01", end: "2025-10-20" },
    },
    isDemo: false,
    current: aggregate,
    previousMonth: aggregate,
    previousYear: aggregate,
    target,
    targetLevel: "ACTIVE",
    portfolio: 0,
    portfolioOrders: 0,
    workingDays: { total: 22, elapsed: 14 },
    daily: [
      { date: "2026-10-01", working: true, revenue: 1000, cumulative: 1000, targetCumulative: 0 },
    ],
    sellers: [],
    drivers: { products: [], customers: [], categories: [], states: [] },
  };
}

const client = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as never;
const query = { company: "00000000-0000-4000-8000-000000000001", period: "2026-10" };

describe("cockpit target", () => {
  it("shows a month without registered targets as 'no target', never as R$ 0", async () => {
    for (const target of [null, 0]) {
      const cockpit = await fetchCockpit(client(raw(target)), query);
      expect(cockpit.kpis["target"]).toMatchObject({
        value: null,
        hint: "Meta não cadastrada para o período",
      });
      expect(cockpit.kpis["target_attainment"]?.value).toBeNull();
      expect(cockpit.kpis["daily_required"]?.value).toBeNull();
      expect(cockpit.daily[0]?.targetCumulative).toBeNull();
    }
  });

  it("keeps a registered target, its attainment and the target line", async () => {
    const cockpit = await fetchCockpit(client(raw(350000)), query);
    expect(cockpit.kpis["target"]?.value).toBe(350000);
    expect(cockpit.kpis["target"]?.hint).toBeUndefined();
    expect(cockpit.kpis["target_attainment"]?.value).not.toBeNull();
    expect(cockpit.daily[0]?.targetCumulative).toBe(0);
  });
});
