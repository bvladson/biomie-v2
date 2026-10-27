/**
 * Fornecedores e prazos (0048) e política de reposição (0049) — acesso ao banco com a sessão do usuário.
 * As regras (quem lê, quem altera, empresa, observação, histórico) ficam nas funções do banco; aqui só se
 * chama e se traduz o erro numa mensagem pronta para a tela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { CompanyFilter } from "@/estoque/api/contract";
import type {
  CustomerMatch,
  ProductSuppliers,
  ReplenishmentPolicies,
  SupplierDetail,
  SupplierList,
  SupplierStatusFilter,
} from "@/estoque/api/suppliers-contract";
import { fromDb } from "./stock.repository.server";

type Db = SupabaseClient<Database>;
type DbError = { code?: string; message: string };
type Rpc = (
  name: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: DbError | null }>;

async function call<T>(db: Db, name: string, args?: Record<string, unknown>): Promise<T> {
  const rpc = (db as unknown as { rpc: Rpc }).rpc.bind(db);
  const { data, error } = await rpc(name, args);
  if (error) throw fromDb(error);
  return data as T;
}

type Saved = { saved?: boolean; removed?: boolean };

export const list = (
  db: Db,
  q: {
    companyId: CompanyFilter;
    search?: string | undefined;
    status?: SupplierStatusFilter | undefined;
    page: number;
  },
) => call<SupplierList>(db, "stock_suppliers", { p_query: q });

export const detail = (db: Db, companyId: string, supplierId: string) =>
  call<SupplierDetail>(db, "stock_supplier", { p_company: companyId, p_supplier: supplierId });

export const ofProduct = (db: Db, companyId: string, omieProductId: string) =>
  call<ProductSuppliers>(db, "stock_product_suppliers", {
    p_company: companyId,
    p_omie: omieProductId,
  });

export const setLeadTime = (
  db: Db,
  i: {
    companyId: string;
    supplierId: string;
    omieProductId?: string | undefined;
    values: { leadTimeDays: number; minLot?: number | null | undefined } | null;
    note: string;
  },
) =>
  call<Saved>(db, "stock_lead_time_set", {
    p_company: i.companyId,
    p_supplier: i.supplierId,
    p_omie: i.omieProductId ?? "",
    p_values: i.values,
    p_note: i.note,
  });

export const setPreferred = (
  db: Db,
  i: { companyId: string; omieProductId: string; supplierId: string | null; note: string },
) =>
  call<Saved>(db, "stock_preferred_supplier_set", {
    p_company: i.companyId,
    p_omie: i.omieProductId,
    p_supplier: i.supplierId,
    p_note: i.note,
  });

export const setLink = (
  db: Db,
  i: {
    companyId: string;
    omieProductId: string;
    supplierId: string;
    linked: boolean;
    note: string;
  },
) =>
  call<{ changed: boolean }>(db, "stock_supplier_link_set", {
    p_company: i.companyId,
    p_omie: i.omieProductId,
    p_supplier: i.supplierId,
    p_linked: i.linked,
    p_note: i.note,
  });

export const search = (db: Db, companyId: string, text: string) =>
  call<CustomerMatch[]>(db, "stock_supplier_search", { p_company: companyId, p_search: text });

export const requestImport = (db: Db, companyId: string) =>
  call<{ queued: boolean; inProgress: boolean; nextAllowedAt: string | null }>(
    db,
    "stock_supplier_request_import",
    { p_company: companyId },
  );

export const policies = (db: Db, companyId: CompanyFilter) =>
  call<ReplenishmentPolicies>(db, "stock_replenishment_policy", { p_company: companyId });

export const setPolicy = (
  db: Db,
  i: {
    companyId: string;
    values: {
      reviewDays: number;
      serviceLevels: Record<"A" | "B" | "C" | "D" | "U", number>;
      maxCoverageDays?: number | null | undefined;
    } | null;
    note: string;
  },
) =>
  call<Saved>(db, "stock_replenishment_policy_set", {
    p_company: i.companyId,
    p_values: i.values,
    p_note: i.note,
  });
