/**
 * BIOMIE Intelligence — leitura dos resultados do motor com a sessão do usuário. As regras (módulo
 * liberado, empresas do usuário, custo e faturamento só para quem pode, exportação) ficam nas
 * funções stock_intel_* da migração 0044; aqui só se chama e se traduz o erro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { CompanyFilter, CurveWindow } from "@/estoque/api/contract";
import type {
  IntelAlert,
  IntelAlertQuery,
  IntelAlertSummary,
  IntelOverview,
  IntelPareto,
  IntelProductDetail,
  IntelProductRow,
  IntelQuery,
  IntelStatus,
  MatrixPoint,
  Opportunity,
  OpportunityQuery,
  PriceBasisRow,
  ReplenishmentQuery,
  ReplenishmentRow,
  ReplenishmentSummary,
} from "@/estoque/api/intel-contract";
import { intelCsv } from "@/estoque/lib/intel";
import { replenishmentCsv } from "@/estoque/lib/intel-insights";
import { capabilities, fromDb, stockError } from "./stock.repository.server";

type Db = SupabaseClient<Database>;
type Rpc = (
  name: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

async function call<T>(db: Db, name: string, args?: Record<string, unknown>): Promise<T> {
  const rpc = (db as unknown as { rpc: Rpc }).rpc.bind(db);
  const { data, error } = await rpc(name, args);
  if (error) throw fromDb(error);
  return data as T;
}

export const status = (db: Db) => call<IntelStatus>(db, "stock_intel_status");

export const overview = (
  db: Db,
  companyId: CompanyFilter,
  window?: CurveWindow,
  supplier?: string,
) =>
  call<IntelOverview>(db, "stock_intel_overview", {
    p_company: companyId,
    p_window: window ?? null,
    p_supplier: supplier ?? null,
  });

export const products = (db: Db, query: IntelQuery) =>
  call<{ rows: IntelProductRow[]; total: number }>(db, "stock_intel_products", { p_query: query });

export const product = (db: Db, companyId: string, omieProductId: string) =>
  call<IntelProductDetail | null>(db, "stock_intel_product", {
    p_company: companyId,
    p_omie: omieProductId,
  });

export const pareto = (db: Db, companyId: string, window?: CurveWindow) =>
  call<IntelPareto>(db, "stock_intel_pareto", { p_company: companyId, p_window: window ?? null });

// ---------------------------------------------------------------- fase 3: alertas
export const alerts = (db: Db, query: IntelAlertQuery) =>
  call<{ rows: IntelAlert[]; total: number; summary: IntelAlertSummary }>(
    db,
    "stock_intel_alerts",
    {
      p_query: query,
    },
  );

export const ackAlert = (db: Db, alertId: string, note: string | null) =>
  call<{ acknowledged: boolean }>(db, "stock_intel_alert_ack", { p_alert: alertId, p_note: note });

// ---------------------------------------------------------------- fase 5: reposição e grupo
export const replenishment = (db: Db, query: ReplenishmentQuery) =>
  call<{ rows: ReplenishmentRow[]; total: number; summary: ReplenishmentSummary }>(
    db,
    "stock_intel_replenishment",
    { p_query: query },
  );

export const opportunities = (db: Db, query: OpportunityQuery) =>
  call<{ rows: Opportunity[]; total: number; note: string }>(db, "stock_intel_opportunities", {
    p_query: query,
  });

export const priceBasis = (db: Db, companyId: CompanyFilter) =>
  call<{ asOf: string | null; prices: PriceBasisRow[] }>(db, "stock_intel_price_basis", {
    p_company: companyId,
  });

export const matrix = (db: Db, companyId: CompanyFilter) =>
  call<{ points: MatrixPoint[]; total: number }>(db, "stock_intel_matrix", {
    p_company: companyId,
  });

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

/** CSV do filtro inteiro montado no servidor; o banco confere a permissão de exportar de novo. */
export async function exportCsv(
  db: Db,
  query: Omit<IntelQuery, "page">,
): Promise<{ fileName: string; csv: string }> {
  const caps = await capabilities(db);
  if (!caps.export) throw stockError("forbidden", "Você não pode exportar o estoque.");
  const data = await products(db, { ...query, page: -1 });
  return {
    fileName: `estoque-inteligencia-${stamp()}.csv`,
    csv: intelCsv(data.rows, caps.viewCost),
  };
}

/** Reposição filtrada em CSV, montada no servidor; o banco confere a permissão de exportar de novo. */
export async function exportReplenishmentCsv(
  db: Db,
  query: Omit<ReplenishmentQuery, "page">,
): Promise<{ fileName: string; csv: string }> {
  const caps = await capabilities(db);
  if (!caps.export) throw stockError("forbidden", "Você não pode exportar o estoque.");
  const data = await replenishment(db, { ...query, page: -1 });
  return {
    fileName: `estoque-reposicao-${stamp()}.csv`,
    csv: replenishmentCsv(data.rows, caps.viewCost),
  };
}
