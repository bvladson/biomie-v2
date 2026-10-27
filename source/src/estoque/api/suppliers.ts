/** SuppliersApi ligado às funções de servidor (as regras ficam no banco). Erros chegam prontos para a tela. */
import type { SuppliersApi } from "./suppliers-contract";
import { toStockError } from "./server-client";
import * as fn from "@/lib/stock-suppliers.functions";

function guarded<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await call(...args);
    } catch (error) {
      throw toStockError(error);
    }
  };
}

export const suppliersApi: SuppliersApi = {
  list: guarded((query) => fn.suppliersList({ data: query })),
  detail: guarded((companyId, supplierId) =>
    fn.supplierDetail({ data: { companyId, supplierId } }),
  ),
  ofProduct: guarded((companyId, omieProductId) =>
    fn.productSuppliers({ data: { companyId, omieProductId } }),
  ),
  setLeadTime: guarded((input) => fn.leadTimeSet({ data: input })),
  setPreferred: guarded((input) => fn.preferredSupplierSet({ data: input })),
  setLink: guarded((input) => fn.supplierLinkSet({ data: input })),
  search: guarded((companyId, text) => fn.supplierSearch({ data: { companyId, text } })),
  requestImport: guarded((companyId) => fn.supplierRequestImport({ data: { companyId } })),
  policies: guarded((companyId) => fn.replenishmentPolicies({ data: { companyId } })),
  setPolicy: guarded((input) => fn.replenishmentPolicySet({ data: input })),
};
