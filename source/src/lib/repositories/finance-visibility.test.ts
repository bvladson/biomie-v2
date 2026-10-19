import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { describe, expect, it, vi } from "vitest";
import { getCustomerFinance, getFinanceSummary } from "./finance.repository.server";

const company = "00000000-0000-4000-8000-000000000001";
const customer = "00000000-0000-4000-8000-000000000002";

describe("Hidden financial values", () => {
  it("preserves withheld balances as null instead of displaying zero", async () => {
    const rpc = vi.fn(async () => ({
      error: null,
      data: {
        ref: "2026-10-19",
        overdueVisible: false,
        open: null,
        openCount: null,
        dueFuture: null,
        overdue: null,
        received: 100,
        receivedDelayWeighted: null,
        capabilities: ["finance.view_summary"],
        aging: [],
        timeline: [],
      },
    }));
    const sb = { rpc } as unknown as SupabaseClient<Database>;
    const result = await getFinanceSummary(sb, { company, period: "2026-10" });
    expect(result.kpis.open).toBeNull();
    expect(result.kpis.openCount).toBeNull();
    expect(result.kpis.dueFuture).toBeNull();
    expect(result.kpis.overdueRate).toBeNull();
    expect(result.kpis.averageDelayDays).toBeNull();
  });

  it("keeps withheld customer balances and settlement delay hidden", async () => {
    const rpc = vi.fn(async () => ({
      error: null,
      data: {
        ref: "2026-10-19",
        overdueVisible: false,
        open: null,
        overdue: null,
        aging: [],
        titles: [],
        settlements: [{ daysLate: null, dueDate: null }],
      },
    }));
    const sb = { rpc } as unknown as SupabaseClient<Database>;
    const result = await getCustomerFinance(sb, company, customer);
    expect(result.open).toBeNull();
    expect(result.settlements[0]?.daysLate).toBeNull();
    expect(result.settlements[0]?.dueDate).toBeNull();
  });
});
