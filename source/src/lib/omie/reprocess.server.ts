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
  /** RAW rows the current adapter cannot turn into Canonical (missing required fields). */
  skipped: number;
  promoted: boolean;
  /** Proven RAW periods re-certified by this reprocess (one REPROCESS run each). */
  periods: { from: string; to: string }[];
}

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Merges overlapping or adjacent periods (same rule as data_coverage). */
export function mergePeriods(periods: { from: string; to: string }[]) {
  const sorted = [...periods].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  const merged: { from: string; to: string }[] = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last && p.from <= nextDay(last.to)) {
      if (p.to > last.to) last.to = p.to;
    } else merged.push({ ...p });
  }
  return merged;
}

/**
 * Re-applies the adapter and the classification rules to the RAW payloads
 * already stored, without calling Omie, then promotes Gold and re-runs the
 * integrity checks. Items are untouched (they do not depend on classification).
 *
 * RAW completeness was proven by the original load (pagination proofs), so each
 * proven period gets a REPROCESS run that inherits raw_complete and certifies the
 * new Canonical/Gold; readiness and coverage then reflect the reprocessed data.
 */
export async function reprocessFromRaw(
  admin: Admin,
  company: string,
  entity: OmieTxEntity,
  pageSize = 500,
): Promise<ReprocessResult> {
  const db = admin as unknown as Loose;
  const startedAt = new Date();
  const { data: running, error: runningError } = await db
    .from("integration_sync_runs")
    .select("id")
    .eq("company_id", company)
    .eq("entity", entity)
    .eq("status", "RUNNING")
    .limit(1);
  if (runningError) throw new Error("Falha ao consultar execuções em andamento.");
  if (running?.length)
    throw new Error(`Há uma sincronização de ${entity} em andamento; pause o worker antes.`);

  const adapter = TX_ADAPTERS[entity];
  const config =
    entity === "settlements" ? {} : await loadLegacyClassificationConfig(admin, company);
  const canonicalTable = entity === "settlements" ? "canonical_settlements" : `canonical_${entity}`;
  let offset = 0;
  const result: ReprocessResult = {
    entity,
    read: 0,
    updated: 0,
    skipped: 0,
    promoted: false,
    periods: [],
  };
  for (;;) {
    const { data, error } = await db
      .from(`raw_omie_${entity}`)
      .select("id,external_id,payload")
      .eq("company_id", company)
      .order("external_id")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Falha ao ler RAW de ${entity}.`);
    const rows = (data ?? []) as {
      id: string;
      external_id: string;
      payload: Record<string, unknown>;
    }[];
    if (!rows.length) break;
    result.read += rows.length;
    const headers = [];
    const converted: string[] = [];
    for (const row of rows) {
      const canonical = adapter.toCanonical(row.payload);
      if (!canonical) {
        result.skipped++;
        continue;
      }
      converted.push(row.id);
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
      const { error: markError } = await db.rpc("mark_raw_processed", {
        p_entity: entity,
        p_company: company,
        p_ids: converted,
        p_state: "CANONICAL",
      });
      if (markError) throw new Error("Falha ao marcar os registros RAW reprocessados.");
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

  const { data: proven, error: provenError } = await db
    .from("integration_sync_runs")
    .select("period_from,period_to")
    .eq("company_id", company)
    .eq("entity", entity)
    .eq("raw_complete", true)
    .in("status", ["SUCCESS", "WARNING"]);
  if (provenError) throw new Error("Falha ao consultar os períodos comprovados.");
  result.periods = mergePeriods(
    ((proven ?? []) as { period_from: string | null; period_to: string | null }[])
      .filter((r) => r.period_from && r.period_to)
      .map((r) => ({ from: r.period_from!, to: r.period_to! })),
  );
  if (result.periods.length) {
    const finishedAt = new Date();
    const complete = result.skipped === 0;
    const { error: runError } = await db.from("integration_sync_runs").insert(
      result.periods.map((p) => ({
        company_id: company,
        provider: "omie",
        entity,
        mode: "REPROCESS",
        status: complete ? "SUCCESS" : "WARNING",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        received: result.read,
        updated: result.updated,
        failed: result.skipped,
        period_from: p.from,
        period_to: p.to,
        raw_complete: true,
        canonical_complete: complete,
        gold_complete: true,
        message: complete
          ? "Reprocessado a partir do RAW, sem chamadas ao Omie."
          : `Reprocessado a partir do RAW, sem chamadas ao Omie. ${result.skipped} registro(s) sem campos obrigatórios (ver RAW).`,
      })),
    );
    if (runError) throw new Error("Gold gravado, mas o registro do reprocessamento falhou.");
  }
  return result;
}
