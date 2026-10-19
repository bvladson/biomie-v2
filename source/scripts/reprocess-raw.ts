/**
 * Reprocess stored RAW payloads with the current adapters/rules (no Omie calls):
 *   node .output/reprocess-raw.mjs <company-slug|all> <invoices|orders|receivables|settlements|all>
 * Run inside the worker container while the worker is paused.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import type { OmieTxEntity } from "../src/lib/omie/adapters";
import { reprocessFromRaw } from "../src/lib/omie/reprocess.server";

const ENTITIES: OmieTxEntity[] = ["invoices", "orders", "receivables", "settlements"];

async function main([selector, entityArg]: string[]) {
  if (!selector || !entityArg) throw new Error("Uso: reprocess-raw <empresa|all> <entidade|all>");
  const query = supabaseAdmin
    .from("companies")
    .select("id,slug")
    .eq("is_demo", false)
    .order("slug");
  const { data: companies, error } =
    selector === "all" ? await query : await query.eq("slug", selector);
  if (error || !companies?.length) throw new Error("Empresa não encontrada.");
  const entities =
    entityArg === "all" ? ENTITIES : ENTITIES.filter((entity) => entity === entityArg);
  if (!entities.length) throw new Error("Entidade inválida.");
  const results = [];
  for (const company of companies)
    for (const entity of entities)
      results.push({
        company: company.slug,
        ...(await reprocessFromRaw(supabaseAdmin, company.id, entity)),
      });
  console.log(JSON.stringify(results, null, 2));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "falha");
  process.exitCode = 1;
});
