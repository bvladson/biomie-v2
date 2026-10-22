/**
 * Conferência do formato real das movimentações de estoque no Omie para uma empresa, antes de
 * ligar a leitura (rodar dentro do contêiner do worker):
 *   node .output/stock-movements-probe.mjs <empresa-slug> [dias=30]
 * Uma página de ListarMovimentoEstoque (de N dias atrás até ontem), pelo limitador compartilhado.
 * Nada é gravado. Mostra só estrutura, contagens, operações e quantos registros a conversão
 * aceitou; nunca valores, nomes, documentos ou credenciais.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { loadOmieCredentials } from "../src/lib/omie/credentials.server";
import { OmieClient, OmieError } from "../src/lib/omie/omie-client";
import {
  MOVEMENTS_CALL,
  MOVEMENTS_LIST_KEYS,
  MOVEMENTS_PATH,
  movementsPageParams,
  toMovementRow,
} from "../src/lib/omie/stock-adapter";

type Row = Record<string, unknown>;
const shape = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Row).sort() : [];

function localDay(offsetDays: number): string {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" })
    .format(new Date(Date.now() + offsetDays * 86_400_000))
    .split("-");
  return `${d}/${m}/${y}`;
}

const count = (values: string[]) =>
  values.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});

async function main([slug, daysArg]: string[]) {
  if (!slug) throw new Error("Uso: stock-movements-probe <empresa> [dias]");
  const days = Math.min(365, Math.max(1, Number(daysArg ?? 30) || 30));
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
  const from = localDay(-days);
  const to = localDay(-1);
  const report: Row = { company: slug, from, to };
  try {
    const page = await client.listPage<Row>(
      MOVEMENTS_PATH,
      MOVEMENTS_CALL,
      movementsPageParams(1, from, to),
      MOVEMENTS_LIST_KEYS,
    );
    const mapped = page.records.map(toMovementRow);
    const ok = mapped.filter((r) => r !== null);
    report["movements"] = {
      ok: true,
      totalRecords: page.totalRecords,
      totalPages: page.totalPages,
      onFirstPage: page.records.length,
      recordKeys: shape(page.records[0]),
      mapped: ok.length,
      skipped: page.records.length - ok.length,
      kinds: count(ok.map((r) => r.kind)),
      operations: count(ok.map((r) => r.operation ?? "?")),
      canceled: ok.filter((r) => r.canceled).length,
      returns: ok.filter((r) => r.is_return).length,
      withLocation: ok.filter((r) => r.location_code !== null).length,
      dateFormat: count(page.records.map((r) => String(r["dtMov"] ?? "").replace(/\d/g, "9"))),
    };
  } catch (e) {
    report["movements"] = {
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
