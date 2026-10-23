/**
 * BIOMIE Intelligence — leitura dos resultados do motor com a sessão do usuário. As regras (módulo
 * liberado, empresas do usuário, custo e faturamento só para quem pode, exportação) ficam nas
 * funções stock_intel_* da migração 0044; aqui só se chama e se traduz o erro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { CompanyFilter, CurveWindow } from "@/estoque/api/contract";
import type {
  IntelOverview,
  IntelPareto,
  IntelProductDetail,
  IntelProductRow,
  IntelQuery,
  IntelStatus,
} from "@/estoque/api/intel-contract";
import { intelCsv } from "@/estoque/lib/intel";
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

export const overview = (db: Db, companyId: CompanyFilter, window?: CurveWindow) =>
  call<IntelOverview>(db, "stock_intel_overview", {
    p_company: companyId,
    p_window: window ?? null,
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
