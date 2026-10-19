/**
 * Small, safe validation of the real Omie request parameters and payload shape
 * for one company (run inside the worker container):
 *   node .output/omie-probe.mjs <company-slug> [from YYYY-MM-DD] [to YYYY-MM-DD]
 * One page of 2 records per transactional method, through the shared rate
 * limiter. Prints only structure, counts and derived classifications; never
 * prints field values, documents, names or credentials.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { TX_ADAPTERS, type OmieTxEntity } from "../src/lib/omie/adapters";
import { classifyOperation } from "../src/lib/omie/classification.server";
import { loadOmieCredentials } from "../src/lib/omie/credentials.server";
import { OmieClient, OmieError } from "../src/lib/omie/omie-client";

type Row = Record<string, unknown>;
const object = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const shape = (v: unknown) => Object.keys(object(v)).sort();
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

async function main([slug, fromArg, toArg]: string[]) {
  if (!slug) throw new Error("Uso: omie-probe <empresa> [from] [to]");
  const { data: company, error } = await supabaseAdmin
    .from("companies")
    .select("id,slug")
    .eq("slug", slug)
    .eq("is_demo", false)
    .single();
  if (error || !company) throw new Error("Empresa não encontrada.");
  const today = new Date().toISOString().slice(0, 10);
  const to = toArg ?? today;
  const from = fromArg ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const client = new OmieClient(await loadOmieCredentials(supabaseAdmin, company.id), {
    maxRetries: 0,
    timeoutMs: 40_000,
  });
  const report: Row = { company: slug, period: { from, to } };
  for (const entity of ["invoices", "orders", "receivables", "settlements"] as OmieTxEntity[]) {
    const adapter = TX_ADAPTERS[entity];
    try {
      const page = await client.listPage<Row>(
        adapter.path,
        adapter.call,
        adapter.pageParams(1, 2, { from, to }),
        adapter.listKeys,
      );
      const first = page.records[0];
      const canonical = first ? adapter.toCanonical(first) : null;
      const entry: Row = {
        ok: true,
        params: Object.keys(adapter.pageParams(1, 2, { from, to })).sort(),
        totalRecords: page.totalRecords,
        totalPages: page.totalPages,
        recordKeys: first ? shape(first) : [],
        rawOk: first ? adapter.toRaw(first) !== null : null,
        canonicalOk: first ? canonical !== null : null,
        headerTypes: canonical
          ? Object.fromEntries(Object.entries(canonical.header).map(([k, v]) => [k, typeOf(v)]))
          : null,
        items: canonical?.items?.length ?? null,
      };
      if (first && entity === "invoices") {
        const det = Array.isArray(first["det"]) ? (first["det"] as Row[]) : [];
        entry["checks"] = {
          ideKeys: shape(first["ide"]),
          icmsTotKeys: shape(object(first["total"])["ICMSTot"]),
          itemCfopPresent: det.every((d) => Boolean(object(d["prod"])["CFOP"])),
          titlesWithSeller: (Array.isArray(first["titulos"])
            ? (first["titulos"] as Row[])
            : []
          ).filter((t) => t["nCodVendedor"]).length,
          operationScope: classifyOperation("invoices", first, {}),
        };
      }
      if (first && entity === "orders") {
        const det = Array.isArray(first["det"]) ? (first["det"] as Row[]) : [];
        entry["checks"] = {
          cabecalhoKeys: shape(first["cabecalho"]),
          sellerPresent: Boolean(object(first["informacoes_adicionais"])["codVend"]),
          itemCfopPresent: det.every((d) => Boolean(object(d["produto"])["cfop"])),
          operationScope: classifyOperation("orders", first, {}),
        };
      }
      report[entity] = entry;
    } catch (e) {
      report[entity] = {
        ok: false,
        kind: e instanceof OmieError ? e.kind : "unexpected",
        message: e instanceof Error ? e.message : "erro",
      };
    }
  }
  // Is there history before the requested window? Totals only.
  try {
    const adapter = TX_ADAPTERS.invoices;
    const year = Number(from.slice(0, 4)) - 1;
    const page = await client.listPage<Row>(
      adapter.path,
      adapter.call,
      adapter.pageParams(1, 1, { from: `${year}-01-01`, to: `${year}-12-31` }),
      adapter.listKeys,
    );
    report["previousYearInvoices"] = { year, totalRecords: page.totalRecords };
  } catch (e) {
    report["previousYearInvoices"] = {
      ok: false,
      message: e instanceof Error ? e.message : "erro",
    };
  }
  console.log(JSON.stringify(report, null, 2));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "falha");
  process.exitCode = 1;
});
