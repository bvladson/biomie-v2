/** StockApi ligado às funções de servidor do BIOMIE (as regras são aplicadas no banco). */
import type { StockApi, StockApiError } from "./contract";
import * as fn from "@/lib/stock.functions";

const CODED = /^(forbidden|invalid|busy|unavailable)::([\s\S]+)$/;
const GENERIC = "Não foi possível carregar o estoque. Tente de novo.";

/** O servidor manda "tipo::mensagem"; qualquer outra falha (rede, sessão) vira a mensagem genérica. */
export function toStockError(error: unknown): StockApiError {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  const coded = CODED.exec(message);
  if (coded) return { code: coded[1] as StockApiError["code"], message: coded[2]! };
  return { code: "unavailable", message: GENERIC };
}

function guarded<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await call(...args);
    } catch (error) {
      throw toStockError(error);
    }
  };
}

export const serverStockApi: StockApi = {
  capabilities: guarded(() => fn.stockCapabilities()),
  overview: guarded((companyId) => fn.stockOverview({ data: { companyId } })),
  positions: guarded((query) => fn.stockPositions({ data: query })),
  filterOptions: guarded((companyId) => fn.stockFilterOptions({ data: { companyId } })),
  setCurve: guarded((input) => fn.stockSetCurve({ data: input })),
  simulationBase: guarded((companyId) => fn.stockSimulationBase({ data: { companyId } })),
  listScenarios: guarded(() => fn.stockListScenarios()),
  saveScenario: guarded((input) => fn.stockSaveScenario({ data: input })),
  deleteScenario: guarded((id) => fn.stockDeleteScenario({ data: { id } }).then(() => undefined)),
  exportCsv: guarded((input) => fn.stockExportCsv({ data: input })),
  requestRefresh: guarded((companyId) => fn.stockRequestRefresh({ data: { companyId } })),
};
