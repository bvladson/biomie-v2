/**
 * VENDEDOR scope end-to-end against the real database (server-side RLS).
 * Temporary user linked to one seller; must see only its own data and get
 * nothing for another seller's id. Opt-in: BIOMIE_RLS_E2E=1.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { getSalesBreakdown, getVendor360 } from "@/lib/repositories/sales.repository.server";
import { getCustomers, getProducts } from "@/lib/repositories/customers-products.repository.server";
import { buildFlightPlan } from "@/lib/repositories/flight-plan.repository.server";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const anon = process.env["SUPABASE_PUBLISHABLE_KEY"];
const run = url && key && anon && process.env["BIOMIE_RLS_E2E"] === "1" ? describe : describe.skip;

run("VENDEDOR sees only its own data (server-side)", () => {
  const admin = createClient<Database>(url!, key!, { auth: { persistSession: false } });
  const email = `vendedor-e2e-${Date.now()}@biomie-test.dev`;
  const password = `T${crypto.randomUUID()}!`;
  let userId = "";
  let company = "";
  let mine = "";
  let other = "";
  let prevUser: string | null = null;
  let user: ReturnType<typeof createClient<Database>>;

  beforeAll(async () => {
    const { data: c } = await admin
      .from("companies")
      .select("id")
      .eq("slug", "mag-moveis")
      .single();
    company = c!.id;
    const { data: s } = await admin
      .from("sellers")
      .select("id,user_id")
      .eq("company_id", company)
      .order("name")
      .limit(2);
    mine = s![0]!.id;
    other = s![1]!.id;
    prevUser = s![0]!.user_id;
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
    await admin.from("sellers").update({ user_id: userId }).eq("id", mine);
    user = createClient<Database>(url!, anon!, { auth: { persistSession: false } });
    await user.auth.signInWithPassword({ email, password });
  }, 30_000);

  afterAll(async () => {
    if (mine) await admin.from("sellers").update({ user_id: prevUser }).eq("id", mine);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("restricts every read model and denies another seller's id", async () => {
    const q = { company, period: "2026-09" };
    const { data: sellers } = await user.from("sellers").select("id").eq("company_id", company);
    expect(sellers!.map((x) => x.id)).toEqual([mine]);

    const [sales, own360, cust, prod, fp] = await Promise.all([
      getSalesBreakdown(user, q, "seller"),
      getVendor360(user, { ...q, seller: mine }),
      getCustomers(user, q),
      getProducts(user, q),
      buildFlightPlan(user, q),
    ]);
    expect(sales.rows.map((r) => r.key)).toEqual([mine]);
    expect(own360.kpis.revenue!).toBeCloseTo(sales.total, 2);
    expect(cust.summary.revenue).toBeCloseTo(sales.total, 2);
    expect(prod.summary.revenue).toBeCloseTo(sales.total, 2);
    expect(fp.vendors.map((v) => v.id)).toEqual([mine]);

    // URL tampering: another seller's id returns no data.
    const otherSales = await getSalesBreakdown(user, { ...q, seller: other }, "seller");
    expect(otherSales.total).toBe(0);
    const { data: inv } = await user.from("invoices").select("id").eq("seller_id", other).limit(1);
    expect(inv).toEqual([]);
    const { data: tg } = await user
      .from("sales_targets")
      .select("id")
      .eq("seller_id", other)
      .limit(1);
    expect(tg).toEqual([]);
    const { error: docErr } = await user.from("customers").select("document").limit(1);
    expect(docErr).not.toBeNull();
  }, 60_000);
});
