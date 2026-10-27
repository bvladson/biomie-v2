import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyFilter, CurveWindow } from "../api/contract";
import { stockApi } from "../api";
export const StockContext = createContext<{
  companyId: CompanyFilter;
  setCompanyId: (v: string) => void;
  /** Janela da curva automática escolhida no topo do Estoque (padrão 12 meses). */
  window: CurveWindow;
  setWindow: (v: CurveWindow) => void;
  /** Fornecedor escolhido no topo (código do Omie, uma empresa por vez); undefined = todos. */
  supplier?: string | undefined;
  supplierName?: string | undefined;
  setSupplier: (v: string | undefined) => void;
}>({
  companyId: "all",
  setCompanyId: () => {},
  window: "12m",
  setWindow: () => {},
  setSupplier: () => {},
});
export const useStockCompany = () => useContext(StockContext);
export const useCapabilities = () =>
  useQuery({
    queryKey: ["stock", "capabilities"],
    queryFn: () => stockApi.capabilities(),
    retry: false,
  });
/** Menu liberado pelo banco ou Super admin (que entra pela URL enquanto o módulo está desligado). */
export function canOpenStock(ctx: { roles: string[]; features?: string[] | undefined }) {
  return (ctx.features ?? []).includes("stock") || ctx.roles.includes("SUPER_ADMIN");
}
