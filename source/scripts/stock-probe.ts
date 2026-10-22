/**
 * Conferência do formato real do estoque no Omie para uma empresa, antes de ligar a leitura
 * (rodar dentro do contêiner do worker):
 *   node .output/stock-probe.mjs <empresa-slug>
 * Uma página de ListarLocaisEstoque e uma de ListarPosEstoque (100 posições), pelo limitador
 * compartilhado. Nada é gravado. Mostra só estrutura, contagens e quantos registros a conversão
 * aceitou; nunca valores, nomes, códigos ou credenciais.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { loadOmieCredentials } from "../src/lib/omie/credentials.server";
import { OmieClient, OmieError } from "../src/lib/omie/omie-client";
import {
  LOCATIONS_CALL,
  LOCATIONS_LIST_KEYS,
  LOCATIONS_PATH,
  MAX_STOCK_PAGES,
  MAX_STOCK_POSITIONS,
  STOCK_CALL,
  STOCK_LIST_KEYS,
  STOCK_PATH,
  locationsPageParams,
  stockPageParams,
  toLocationEntry,
  toStockRow,
} from "../src/lib/omie/stock-adapter";

type Row = Record<string, unknown>;
const shape = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Row).sort() : [];

function today(): string {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" })
    .format(new Date())
    .split("-");
  return `${d}/${m}/${y}`;
}

async function main([slug]: string[]) {
  if (!slug) throw new Error("Uso: stock-probe <empresa>");
  const { data: company, error } = await supabaseAdmin
    .from("companies")
    .select("id,slug")
    .eq("slug", slug)
    .eq("is_demo", false)
    .single();
  if (error || !company) throw new Error("Empresa não encontrada.");
  const client = new OmieClient(await loadOmieCredentials(supabaseAdmin, company.id), {
    maxRetries: 0,
    timeoutMs: 40_000,
  });
  const report: Row = { company: slug, positionDate: today() };
  try {
    const page = await client.listPage<Row>(
      LOCATIONS_PATH,
      LOCATIONS_CALL,
      locationsPageParams(1),
      LOCATIONS_LIST_KEYS,
    );
    report["locations"] = {
      ok: true,
      totalRecords: page.totalRecords,
      totalPages: page.totalPages,
      recordKeys: shape(page.records[0]),
      mapped: page.records.filter((r) => toLocationEntry(r) !== null).length,
      withName: page.records.filter((r) => toLocationEntry(r)?.[1].name).length,
    };
  } catch (e) {
    report["locations"] = {
      ok: false,
      kind: e instanceof OmieError ? e.kind : "unexpected",
      message: e instanceof Error ? e.message : "erro",
    };
  }
  try {
    const page = await client.listPage<Row>(
      STOCK_PATH,
      STOCK_CALL,
      stockPageParams(1, today()),
      STOCK_LIST_KEYS,
    );
    const failures: Record<string, number> = {};
    let mapped = 0;
    let negative = 0;
    let zero = 0;
    for (const record of page.records) {
      try {
        const row = toStockRow(record);
        mapped++;
        if (row.physical_qty < 0) negative++;
        if (row.physical_qty === 0 && row.reserved_qty === 0 && row.pending_qty === 0) zero++;
      } catch (e) {
        const key = e instanceof Error ? e.message : "erro";
        failures[key] = (failures[key] ?? 0) + 1;
      }
    }
    const locations = new Set(
      page.records.map((r) => String(r["codigo_local_estoque"] ?? "total")),
    );
    report["positions"] = {
      ok: true,
      totalRecords: page.totalRecords,
      totalPages: page.totalPages,
      recordKeys: shape(page.records[0]),
      onFirstPage: page.records.length,
      mapped,
      failures,
      negativeOnFirstPage: negative,
      zeroOnFirstPage: zero,
      locationsOnFirstPage: locations.size,
      withinLimit:
        (page.totalRecords ?? 0) <= MAX_STOCK_POSITIONS && page.totalPages <= MAX_STOCK_PAGES,
    };
  } catch (e) {
    report["positions"] = {
      ok: false,
      kind: e instanceof OmieError ? e.kind : "unexpected",
      message: e instanceof Error ? e.message : "erro",
    };
  }
  console.log(JSON.stringify(report, null, 2));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "falha");
  process.exitCode = 1;
});
