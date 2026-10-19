import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

/**
 * Negative security checks: an anonymous caller (no session) must never
 * execute privileged functions or read integration tables. Runs against the
 * configured backend with the public key only.
 */
const url = process.env["VITE_SUPABASE_URL"];
const key = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
const run = url && key ? describe : describe.skip;
const ZERO = "00000000-0000-0000-0000-000000000000";

run("RPC security (anonymous)", () => {
  const anon = createClient(url!, key!, { auth: { persistSession: false } });
  const denied: [string, Record<string, unknown>][] = [
    ["get_integration_credentials", { p_company: ZERO, p_provider: "omie" }],
    ["ingest_omie_raw", { p_entity: "vendors", p_company: ZERO, p_run: ZERO, p_rows: [] }],
    ["promote_omie_gold", { p_company: ZERO, p_entity: "vendors" }],
    ["omie_readiness", { p_company: ZERO }],
    ["manage_backfill", { p_company: ZERO, p_action: "create" }],
    ["run_integrity_checks", { p_company: ZERO }],
    ["finance_summary", { p_company: ZERO, p_start: "2026-01-01", p_end: "2026-01-31" }],
    ["reveal_customer_document", { p_customer: ZERO, p_reason: "teste" }],
    [
      "set_company_data_source",
      { p_company: ZERO, p_source: "OMIE", p_confirmation: "ATIVAR OMIE" },
    ],
    ["accessible_company_ids", { _user_id: ZERO }],
  ];
  for (const [fn, args] of denied) {
    it(`anon cannot execute ${fn}`, async () => {
      const { error } = await anon.rpc(fn as never, args as never);
      expect(error).not.toBeNull();
    });
  }
  it("anon cannot read RAW, canonical or integrity tables", async () => {
    for (const t of [
      "raw_omie_invoices",
      "canonical_invoices",
      "integrity_issues",
      "integration_backfill_jobs",
    ]) {
      const { data } = await anon
        .from(t as never)
        .select("*")
        .limit(1);
      expect(data ?? []).toHaveLength(0);
    }
  });
});
