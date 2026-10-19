/**
 * Financeiro invariants against the real database (service role).
 * Skipped without server credentials. Permission tests are opt-in
 * (BIOMIE_RLS_E2E=1) because they create a temporary VENDEDOR account.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import {
  getCustomerFinance,
  getFinanceSummary,
  getFinanceTitles,
} from "@/lib/repositories/finance.repository.server";
import { overdueRate, receivableTicket, weightedAverageDays } from "@/domain/metrics/compute";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const anon = process.env["SUPABASE_PUBLISHABLE_KEY"];
const run = url && key ? describe : describe.skip;
const runE2E =
  url && key && anon && process.env["BIOMIE_RLS_E2E"] === "1" ? describe : describe.skip;
const cents = (v: number | null) => {
  expect(v).not.toBeNull();
  return Math.round(v! * 100);
};

describe("finance ratios (pure)", () => {
  it("handles zero denominators and hidden overdue", () => {
    expect(overdueRate(null, 100)).toBeNull();
    expect(overdueRate(25, 100)).toBe(0.25);
    expect(overdueRate(0, 0)).toBeNull();
    expect(weightedAverageDays(300, 100)).toBe(3);
    expect(receivableTicket(1000, 0)).toBeNull();
  });
});

run("Financeiro invariants (demo data)", () => {
  const sb = createClient<Database>(url!, key!, { auth: { persistSession: false } });
  let company = "";
  beforeAll(async () => {
    const { data } = await sb.from("companies").select("id").eq("slug", "mag-moveis").single();
    company = data!.id;
  });

  it("cancelled titles stay out of active indicators; overdue ⊆ open", async () => {
    const q = { company, period: "2026-09" };
    const [s, t] = await Promise.all([getFinanceSummary(sb, q), getFinanceTitles(sb, q)]);
    const active = t.rows.filter((r) => r.status !== "CANCELLED");
    expect(t.rows.filter((r) => r.status === "CANCELLED").every((r) => r.open === 0)).toBe(true);
    expect(s.kpis.overdue!).toBeLessThanOrEqual(s.kpis.open!);
    expect(cents(s.kpis.overdue! + s.kpis.dueFuture!)).toBe(cents(s.kpis.open));
    // every overdue title has due < ref and balance > 0
    for (const r of active.filter((x) => x.status === "OVERDUE")) {
      expect(r.dueDate < s.ref).toBe(true);
      expect(r.open).toBeGreaterThan(0);
    }
    expect(cents(active.reduce((a, r) => a + r.open, 0))).toBe(cents(s.kpis.open));
    const agingTotal = s.aging.reduce((a, r) => a + (r.value ?? 0), 0);
    expect(cents(agingTotal)).toBe(cents(s.kpis.open));
  }, 60_000);

  it("partial payment keeps the balance; received uses settlement date", async () => {
    const t = await getFinanceTitles(sb, { company, period: "2026-09" });
    const partial = t.rows.filter((r) => r.paid > 0 && r.open > 0);
    expect(partial.length).toBeGreaterThan(0);
    for (const r of partial) expect(cents(r.original + r.adjustments - r.paid)).toBe(cents(r.open));

    const { data: st, error: settlementsError } = await sb
      .from("financial_settlements")
      .select(
        "amount, settlement_date, financial_titles!financial_settlements_title_id_fkey!inner(cancelled_at)",
      )
      .eq("company_id", company)
      .gte("settlement_date", "2026-09-01")
      .lte("settlement_date", "2026-09-30");
    expect(settlementsError).toBeNull();
    const expected = (st ?? [])
      .filter((x) => !(x.financial_titles as { cancelled_at: string | null }).cancelled_at)
      .reduce((a, x) => a + Number(x.amount), 0);
    const s = await getFinanceSummary(sb, { company, period: "2026-09" });
    expect(cents(s.kpis.received)).toBe(cents(expected));
  }, 60_000);

  it("filters preserve consistency (Σ by state = total)", async () => {
    const all = await getFinanceSummary(sb, { company, period: "2026-09" });
    const t = await getFinanceTitles(sb, { company, period: "2026-09" });
    const { data: states } = await sb.from("customers").select("state").eq("company_id", company);
    const uniq = [...new Set((states ?? []).map((s) => s.state))];
    const parts = await Promise.all(
      uniq.map((state) => getFinanceSummary(sb, { company, period: "2026-09", state })),
    );
    expect(cents(parts.reduce((a, p) => a + p.kpis.open!, 0))).toBe(cents(all.kpis.open));
    expect(cents(parts.reduce((a, p) => a + p.kpis.received, 0))).toBe(cents(all.kpis.received));
    expect(t.rows.length).toBeGreaterThan(0);
  }, 90_000);

  it("Cliente 360 reconciles with Financeiro", async () => {
    const t = await getFinanceTitles(sb, { company, period: "2026-10" });
    const target = t.rows.find((r) => r.status === "OVERDUE" && r.customerId)!;
    const cust = await getCustomerFinance(sb, company, target.customerId!);
    const own = t.rows.filter(
      (r) => r.customerId === target.customerId && r.status !== "CANCELLED",
    );
    expect(cents(cust.open)).toBe(cents(own.reduce((a, r) => a + r.open, 0)));
    expect(cents(cust.overdue!)).toBe(
      cents(own.filter((r) => r.status === "OVERDUE").reduce((a, r) => a + r.open, 0)),
    );
    const agingTotal = cust.aging.reduce((a, r) => a + (r.value ?? 0), 0);
    expect(cents(agingTotal)).toBe(cents(cust.open));
  }, 60_000);

  it("reconciliation stores every check and the finance balance rule holds", async () => {
    const { data: runId, error } = await sb.rpc("run_reconciliation", {
      p_company: company,
      p_period: "2026-09",
    });
    expect(error).toBeNull();
    const { data: results } = await sb
      .from("reconciliation_results")
      .select("check_key, status, abs_diff")
      .eq("run_id", String(runId));
    expect(results!.length).toBe(7);
    const bal = results!.find((r) => r.check_key === "finance_balance")!;
    expect(Number(bal.abs_diff)).toBe(0);
  }, 60_000);
});

runE2E("finance permissions are enforced server-side", () => {
  const admin = createClient<Database>(url!, key!, { auth: { persistSession: false } });
  const email = `fin-e2e-${Date.now()}@biomie-test.dev`;
  const password = `T${crypto.randomUUID()}!`;
  let userId = "";
  let company = "";
  let customer = "";
  let user: ReturnType<typeof createClient<Database>>;

  beforeAll(async () => {
    const { data: c } = await admin
      .from("companies")
      .select("id")
      .eq("slug", "mag-moveis")
      .single();
    company = c!.id;
    const { data: seller } = await admin
      .from("sellers")
      .select("id")
      .eq("company_id", company)
      .order("name")
      .limit(1)
      .single();
    const { data: t } = await admin
      .from("financial_titles")
      .select("customer_id")
      .eq("seller_id", seller!.id)
      .limit(1)
      .single();
    customer = t!.customer_id!;
    const { data: u, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    userId = u.user.id;
    await admin.from("profiles").upsert({ id: userId, email, default_company_id: company });
    await admin.from("user_roles").insert({ user_id: userId, role: "VENDEDOR" });
    await admin.from("user_company_access").insert({ user_id: userId, company_id: company });
    await admin.from("sellers").update({ user_id: userId }).eq("id", seller!.id);
    user = createClient<Database>(url!, anon!, { auth: { persistSession: false } });
    await user.auth.signInWithPassword({ email, password });
  }, 30_000);

  afterAll(async () => {
    await admin.from("sellers").update({ user_id: null }).eq("user_id", userId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("VENDEDOR gets summary without overdue, no titles, no customer details", async () => {
    const s = await getFinanceSummary(user, { company, period: "2026-09" });
    expect(s.overdueVisible).toBe(false);
    expect(s.kpis.overdue).toBeNull();
    expect(s.kpis.customersOverdue).toBeNull();
    expect(s.kpis.open).toBeNull();
    expect(s.kpis.openCount).toBeNull();
    expect(s.kpis.dueFuture).toBeNull();
    expect(s.aging.filter((a) => a.bucket !== "future").every((a) => a.value == null)).toBe(true);
    await expect(getFinanceTitles(user, { company, period: "2026-09" })).rejects.toThrow(
      /permiss/i,
    );
    await expect(getCustomerFinance(user, company, customer)).rejects.toThrow(/permiss/i);
    const { data: raw } = await user.from("financial_titles").select("id").limit(1);
    expect(raw ?? []).toHaveLength(0);
  }, 60_000);

  it("explicit grant unlocks overdue for that VENDEDOR only", async () => {
    await admin
      .from("user_permissions")
      .insert({ user_id: userId, permission: "finance.view_overdue" });
    const s = await getFinanceSummary(user, { company, period: "2026-09" });
    expect(s.overdueVisible).toBe(true);
    expect(s.kpis.overdue).not.toBeNull();
    const all = await getFinanceSummary(admin, { company, period: "2026-09" });
    expect(s.kpis.open).toBeLessThan(all.kpis.open!);
  }, 60_000);
});
