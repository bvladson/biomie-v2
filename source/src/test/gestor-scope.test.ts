/**
 * GESTOR scope end-to-end against the real database (server-side RLS, not UI).
 * Creates a temporary user, grants GESTOR + company access + one team, signs in
 * as that user and checks every scoped read model, then deletes everything.
 * Opt-in (creates an auth user): BIOMIE_RLS_E2E=1 with server credentials.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { getSalesBreakdown } from "@/lib/repositories/sales.repository.server";
import { getCustomers, getProducts } from "@/lib/repositories/customers-products.repository.server";
import { buildFlightPlan } from "@/lib/repositories/flight-plan.repository.server";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const anon = process.env["SUPABASE_PUBLISHABLE_KEY"];
const run = url && key && anon && process.env["BIOMIE_RLS_E2E"] === "1" ? describe : describe.skip;

run("GESTOR sees only sellers of managed teams (server-side)", () => {
  const admin = createClient<Database>(url ?? "http://127.0.0.1:9", key ?? "skipped", {
    auth: { persistSession: false },
  });
  const email = `gestor-e2e-${Date.now()}@biomie-test.dev`;
  const password = `T${crypto.randomUUID()}!`;
  let userId = "";
  let company = "";
  let teamSellers: string[] = [];
  let user: ReturnType<typeof createClient<Database>>;

  beforeAll(async () => {
    const { data: c } = await admin
      .from("companies")
      .select("id")
      .eq("slug", "mag-moveis")
      .single();
    company = c!.id;
    const { data: u, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    userId = u.user.id;
    await admin.from("profiles").upsert({ id: userId, email, default_company_id: company });
    await admin.from("user_roles").insert({ user_id: userId, role: "GESTOR" });
    await admin.from("user_company_access").insert({ user_id: userId, company_id: company });
    const { data: team } = await admin
      .from("sales_teams")
      .select("id")
      .eq("company_id", company)
      .eq("name", "Equipe Corporativo")
      .single();
    await admin.from("sales_team_managers").insert({ team_id: team!.id, user_id: userId });
    const { data: m } = await admin
      .from("sales_team_members")
      .select("seller_id")
      .eq("team_id", team!.id)
      .is("valid_to", null);
    teamSellers = (m ?? []).map((x) => x.seller_id);
    user = createClient<Database>(url!, anon!, { auth: { persistSession: false } });
    await user.auth.signInWithPassword({ email, password });
  }, 30_000);

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("restricts sellers, sales, customers, products and Plano de Voo", async () => {
    const q = { company, period: "2026-09" };
    const { data: sellers } = await user.from("sellers").select("id").eq("company_id", company);
    expect(new Set(sellers!.map((s) => s.id))).toEqual(new Set(teamSellers));

    const [mine, all, custMine, custAll, prodMine, prodAll, fp] = await Promise.all([
      getSalesBreakdown(user, q, "seller"),
      getSalesBreakdown(admin, q, "seller"),
      getCustomers(user, q),
      getCustomers(admin, q),
      getProducts(user, q),
      getProducts(admin, q),
      buildFlightPlan(user, q),
    ]);
    expect(mine.rows.every((r) => r.key && teamSellers.includes(r.key))).toBe(true);
    expect(mine.total).toBeLessThan(all.total);
    expect(custMine.summary.revenue).toBeCloseTo(mine.total, 2);
    // Demo customers buy from several sellers, so the count may match; revenue must not.
    expect(custMine.rows.length).toBeLessThanOrEqual(custAll.rows.length);
    expect(custMine.summary.revenue).toBeLessThan(custAll.summary.revenue);

    // URL tampering: a seller outside the team returns nothing.
    const outsider = all.rows.find((r) => r.key && !teamSellers.includes(r.key))!.key!;
    const tampered = await getSalesBreakdown(user, { ...q, seller: outsider }, "seller");
    expect(tampered.total).toBe(0);
    const { data: tg } = await user.from("sales_targets").select("id").eq("seller_id", outsider);
    expect(tg).toEqual([]);
    const { data: oo } = await user.from("sales_orders").select("id").eq("seller_id", outsider);
    expect(oo).toEqual([]);
    expect(prodMine.summary.revenue).toBeCloseTo(mine.total, 2);
    expect(prodMine.summary.revenue).toBeLessThan(prodAll.summary.revenue);
    expect(fp.vendors.every((v) => teamSellers.includes(v.id))).toBe(true);
  }, 60_000);
});
