/**
 * Estoque — acesso ao banco com a sessão do usuário. Toda regra (papel, empresa, custo,
 * liberação do módulo) é aplicada nas funções stock_* da migração 0041; aqui só se chama e
 * se traduz o erro numa mensagem pronta para a tela, com o tipo na frente ("tipo::mensagem").
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type {
  ClassifiedCurve,
  CompanyFilter,
  CurveWindow,
  PositionQuery,
  SavedScenario,
  ScenarioInput,
  SimulationItem,
  StockApiError,
  StockCapabilities,
  StockFilterOptions,
  StockOverview,
  StockPosition,
} from "@/estoque/api/contract";
import { positionsCsv, simulationCsv } from "@/estoque/lib/export";

type Db = SupabaseClient<Database>;
type DbError = { code?: string; message: string };
// Funções da migração 0041, ainda fora dos tipos gerados.
type Rpc = (
  name: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: DbError | null }>;

export function stockError(code: StockApiError["code"], message: string): Error {
  return new Error(`${code}::${message}`);
}

/** Só mensagens escritas pelas funções do Estoque chegam à tela; o resto vira um texto genérico. */
export function fromDb(error: DbError): Error {
  const own = !/^permission denied/i.test(error.message);
  if (own && error.code === "42501") return stockError("forbidden", error.message);
  if (own && (error.code === "P0001" || error.code === "P0002"))
    return stockError("invalid", error.message);
  console.error(`[estoque] falha no banco code=${error.code ?? "?"}`);
  return stockError("unavailable", "Não foi possível carregar o estoque. Tente de novo.");
}

async function call<T>(db: Db, name: string, args?: Record<string, unknown>): Promise<T> {
  const rpc = (db as unknown as { rpc: Rpc }).rpc.bind(db);
  const { data, error } = await rpc(name, args);
  if (error) throw fromDb(error);
  return data as T;
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

export const capabilities = (db: Db) => call<StockCapabilities>(db, "stock_capabilities");

export const overview = (
  db: Db,
  companyId: CompanyFilter,
  window?: CurveWindow,
  supplier?: string,
) =>
  call<StockOverview>(db, "stock_overview", {
    p_company: companyId,
    p_window: window ?? null,
    p_supplier: supplier ?? null,
  });

export const positions = (db: Db, query: PositionQuery) =>
  call<{ rows: StockPosition[]; total: number }>(db, "stock_positions", { p_query: query });

export const filterOptions = (db: Db, companyId: CompanyFilter) =>
  call<StockFilterOptions>(db, "stock_filter_options", { p_company: companyId });

export const setCurve = (
  db: Db,
  positionIds: string[],
  curve: ClassifiedCurve | "AUTO",
  reason?: string,
) =>
  call<{ updated: number }>(db, "stock_set_curve", {
    p_position_ids: positionIds,
    p_curve: curve,
    p_reason: reason ?? null,
  });

export const simulationBase = (db: Db, companyId: CompanyFilter, window?: CurveWindow) =>
  call<{ items: SimulationItem[]; readAt: string | null }>(db, "stock_simulation_base", {
    p_company: companyId,
    p_window: window ?? null,
  });

export const listScenarios = (db: Db) => call<SavedScenario[]>(db, "stock_scenarios");

export const saveScenario = (
  db: Db,
  input: ScenarioInput & { name: string; id?: string | undefined },
) => call<SavedScenario>(db, "stock_save_scenario", { p_scenario: input });

export const deleteScenario = (db: Db, id: string) =>
  call<null>(db, "stock_delete_scenario", { p_id: id }).then(() => undefined);

export const requestRefresh = (db: Db, companyId: string) =>
  call<{ queued: boolean; nextAllowedAt: string | null; inProgress?: boolean }>(
    db,
    "stock_request_refresh",
    { p_company: companyId },
  );

export const features = async (db: Db): Promise<string[]> => {
  const rpc = (db as unknown as { rpc: Rpc }).rpc.bind(db);
  const { data, error } = await rpc("my_features");
  // Banco sem a migração 0041 (ou falha momentânea): nenhum módulo novo aparece.
  return !error && Array.isArray(data)
    ? data.filter((x): x is string => typeof x === "string")
    : [];
};

/** CSV montado no servidor com a mesma função de simulação da tela (filtro inteiro, não a página). */
export async function exportCsv(
  db: Db,
  input:
    | { kind: "positions"; query: Omit<PositionQuery, "page"> }
    | {
        kind: "simulation";
        companyId: CompanyFilter;
        scenario: ScenarioInput;
        window?: CurveWindow | undefined;
      },
): Promise<{ fileName: string; csv: string }> {
  const caps = await capabilities(db);
  if (!caps.export) throw stockError("forbidden", "Você não pode exportar o estoque.");
  if (input.kind === "positions") {
    // page = -1: todas as linhas do filtro (a função confere a permissão de exportar de novo).
    const data = await positions(db, { ...input.query, page: -1 });
    return {
      fileName: `estoque-posicoes-${stamp()}.csv`,
      csv: positionsCsv(data.rows, caps.viewCost, input.query.window),
    };
  }
  const base = await simulationBase(db, input.companyId, input.window);
  return {
    fileName: `estoque-simulacao-${stamp()}.csv`,
    csv: simulationCsv(base.items, input.scenario),
  };
}
