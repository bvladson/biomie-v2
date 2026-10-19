import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { TX_ADAPTERS, type OmieTxEntity } from "./adapters";
import { classifyCanonicalHeader, loadLegacyClassificationConfig } from "./classification.server";

type Admin = SupabaseClient<Database>;
// Raw/canonical tables are addressed dynamically.
type Loose = { from: (t: string) => any; rpc: (f: string, a?: unknown) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ReprocessResult {
  entity: OmieTxEntity;
  read: number;
  updated: number;
  skipped: number;
  promoted: boolean;
}

/**
 * Re-applies the adapter and the classification rules to the RAW payloads
 * already stored, without calling Omie, then promotes Gold and re-runs the
 * integrity checks. Items are untouched (they do not depend on classification).
 */
export async function reprocessFromRaw(
  admin: Admin,
  company: string,
  entity: OmieTxEntity,
  pageSize = 500,
): Promise<ReprocessResult> {
  const db = admin as unknown as Loose;
  const adapter = TX_ADAPTERS[entity];
  const config =
    entity === "settlements" ? {} : await loadLegacyClassificationConfig(admin, company);
  const canonicalTable = entity === "settlements" ? "canonical_settlements" : `canonical_${entity}`;
  let offset = 0;
  const result: ReprocessResult = { entity, read: 0, updated: 0, skipped: 0, promoted: false };
  for (;;) {
    const { data, error } = await db
      .from(`raw_omie_${entity}`)
      .select("external_id,payload")
      .eq("company_id", company)
      .order("external_id")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Falha ao ler RAW de ${entity}.`);
    const rows = (data ?? []) as { external_id: string; payload: Record<string, unknown> }[];
    if (!rows.length) break;
    result.read += rows.length;
    const headers = [];
    for (const row of rows) {
      const canonical = adapter.toCanonical(row.payload);
      if (!canonical) {
        result.skipped++;
        continue;
      }
      headers.push({
        company_id: company,
        source: "omie",
        external_id: row.external_id,
        ...classifyCanonicalHeader(entity, row.external_id, row.payload, canonical.header, config),
      });
    }
    if (headers.length) {
      const { error: upsertError } = await db
        .from(canonicalTable)
        .upsert(headers, { onConflict: "company_id,source,external_id" });
      if (upsertError) throw new Error(`Falha ao regravar Canonical: ${upsertError.message}`);
      result.updated += headers.length;
    }
    offset += pageSize;
  }
  const goldEntity = entity === "settlements" ? "receivables" : entity;
  const { error: promoteError } = await db.rpc("promote_omie_gold", {
    p_company: company,
    p_entity: goldEntity,
  });
  if (promoteError) throw new Error(`Falha na promoção Gold: ${promoteError.message}`);
  const { error: integrityError } = await db.rpc("run_integrity_checks", { p_company: company });
  if (integrityError) throw new Error("Gold gravado, mas a verificação de integridade falhou.");
  result.promoted = true;
  return result;
}
