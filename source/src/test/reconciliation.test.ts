/**
 * Reconciliation across modules against the real database (service role).
 * Skipped when server credentials are not available (e.g. CI without secrets).
 * cockpit.revenue === sales.revenue === flightPlan.realized === Σ sellers, per filter context.
 */
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import type { AnalyticsQuery } from "@/domain/filters";
import { buildFlightPlan } from "@/lib/repositories/flight-plan.repository.server";
import {
  getSalesBreakdown,
  getSalesSummary,
  getVendor360,
} from "@/lib/repositories/sales.repository.server";
import { fetchCockpit } from "@/lib/repositories/analytics.repository.server";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const run = url && key ? describe : describe.skip;

run("Revenue reconciliation (Cockpit = Plano de Voo = Vendas = Vendedor 360)", () => {
  const sb = createClient<Database>(url!, key!, { auth: { persistSession: false } });
  const cents = (v: number) => Math.round(v * 100);

  async function ctx() {
    const { data } = await sb.from("companies").select("id").eq("slug", "mag-moveis").single();
    const { data: seller } = await sb
      .from("sellers")
      .select("id")
      .eq("company_id", data!.id)
      .order("name")
      .limit(1)
      .single();
    return { company: data!.id, seller: seller!.id };
  }

  for (const [label, extra] of [
    ["closed month", { period: "2026-09" }],
    ["current month", { period: "2026-10" }],
    ["category filter", { period: "2026-09", category: "Mesas" }],
    ["state filter", { period: "2026-08", state: "SP" }],
  ] as const) {
    it(`matches for ${label}`, async () => {
      const { company } = await ctx();
      const q: AnalyticsQuery = { company, ...extra };
      const [cockpit, fp, sales, bySeller] = await Promise.all([
        fetchCockpit(sb, q),
        buildFlightPlan(sb, q),
        getSalesSummary(sb, q),
        getSalesBreakdown(sb, q, "seller"),
      ]);
      const salesRevenue = sales.kpis.find((k) => k.key === "revenue")!.value!;
      expect(cents(cockpit.kpis["revenue"]!.value!)).toBe(cents(salesRevenue));
      expect(cents(fp.summary.realized)).toBe(cents(salesRevenue));
      expect(cents(fp.reconciliation.sellers)).toBe(cents(fp.summary.realized));
      expect(cents(bySeller.total)).toBe(cents(salesRevenue));
    }, 30_000);
  }

  it("Vendedor 360 matches the seller row of the Plano de Voo and seller-filtered Vendas", async () => {
    const { company, seller } = await ctx();
    const q = { company, period: "2026-09", seller };
    const [v360, fp] = await Promise.all([
      getVendor360(sb, q),
      buildFlightPlan(sb, { company, period: "2026-09" }),
    ]);
    const row = fp.vendors.find((v) => v.id === seller)!;
    expect(cents(v360.kpis.revenue!)).toBe(cents(row.metrics.realized));
    expect(cents(v360.plan.summary.realized)).toBe(cents(row.metrics.realized));
    expect(v360.history).toHaveLength(12);
  }, 30_000);

  it("category filter restricts the portfolio to items of that category", async () => {
    const { company } = await ctx();
    const all = await fetchCockpit(sb, { company, period: "2026-10" });
    const cat = await fetchCockpit(sb, { company, period: "2026-10", category: "Mesas" });
    expect(cat.kpis["portfolio"]!.value!).toBeLessThan(all.kpis["portfolio"]!.value!);
  }, 30_000);
});

run("Customers / Products reconciliation and central target level", () => {
  const sb = createClient<Database>(url!, key!, { auth: { persistSession: false } });
  const cents = (v: number) => Math.round(v * 100);

  for (const extra of [
    { period: "2026-09" },
    { period: "2026-10", category: "Mesas" },
    { period: "2026-08", state: "SP" },
  ]) {
    it(`Vendas = Σ clientes = Σ produtos = Σ vendedores (${JSON.stringify(extra)})`, async () => {
      const { data: c } = await sb.from("companies").select("id").eq("slug", "mag-moveis").single();
      const q: AnalyticsQuery = { company: c!.id, ...extra };
      const { getCustomers, getProducts } =
        await import("@/lib/repositories/customers-products.repository.server");
      const [sales, customers, products, sellers] = await Promise.all([
        getSalesSummary(sb, q),
        getCustomers(sb, q),
        getProducts(sb, q),
        getSalesBreakdown(sb, q, "seller"),
      ]);
      const total = cents(sales.kpis.find((k) => k.key === "revenue")!.value!);
      const sum = (xs: { revenue: number }[]) => cents(xs.reduce((a, r) => a + r.revenue, 0));
      expect(sum(customers.rows) + cents(customers.summary.unassignedRevenue)).toBe(total);
      expect(sum(products.rows)).toBe(total);
      expect(cents(products.summary.revenue)).toBe(total);
      expect(sum(sellers.rows)).toBe(total); // includes "Não atribuído" row when present
    }, 30_000);
  }

  it("Cockpit and Plano de Voo use the same configured target level", async () => {
    const { data: c } = await sb.from("companies").select("id").eq("slug", "mag-moveis").single();
    const q = { company: c!.id, period: "2026-09" };
    const [cockpit, fp] = await Promise.all([fetchCockpit(sb, q), buildFlightPlan(sb, q)]);
    expect(cockpit.targetLevel).toBe(fp.config.activeLevel);
    expect(cents(cockpit.kpis["target"]!.value!)).toBe(cents(fp.summary.target));
  }, 30_000);
});
