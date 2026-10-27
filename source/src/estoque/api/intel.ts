/** IntelApi ligado às funções de servidor (as regras ficam no banco). Erros chegam prontos para a tela. */
import type { IntelApi } from "./intel-contract";
import { toStockError } from "./server-client";
import * as fn from "@/lib/stock-intel.functions";

function guarded<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await call(...args);
    } catch (error) {
      throw toStockError(error);
    }
  };
}

export const intelApi: IntelApi = {
  status: guarded(() => fn.intelStatus()),
  overview: guarded((companyId, window, supplier) =>
    fn.intelOverview({ data: { companyId, window, supplier } }),
  ),
  products: guarded((query) => fn.intelProducts({ data: query })),
  product: guarded((companyId, omieProductId) =>
    fn.intelProduct({ data: { companyId, omieProductId } }),
  ),
  pareto: guarded((companyId, window) => fn.intelPareto({ data: { companyId, window } })),
  exportCsv: guarded((query) => fn.intelExport({ data: query })),
  alerts: guarded((query) => fn.intelAlerts({ data: query })),
  ackAlert: guarded((alertId, note) => fn.intelAckAlert({ data: { alertId, note } })),
  replenishment: guarded((query) => fn.intelReplenishment({ data: query })),
  exportReplenishmentCsv: guarded((query) => fn.intelReplenishmentExport({ data: query })),
  opportunities: guarded((query) => fn.intelOpportunities({ data: query })),
  priceBasis: guarded((companyId) => fn.intelPriceBasis({ data: { companyId } })),
  matrix: guarded((companyId) => fn.intelMatrix({ data: { companyId } })),
};
