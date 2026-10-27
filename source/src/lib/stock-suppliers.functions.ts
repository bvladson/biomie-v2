/**
 * Funções de servidor de fornecedores e prazos (migração 0048) e da política de reposição (0049). Toda
 * decisão de permissão é do banco (stock_internal: Compras e Super admin alteram); aqui só se valida o
 * formato da entrada e se delega ao repositório, carregado apenas no servidor.
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const repo = () => import("./repositories/stock-suppliers.repository.server");
const noStore = () => setResponseHeader("Cache-Control", "no-store");

const companyOrAll = z.union([z.literal("all"), z.string().uuid()]);
const company = z.string().uuid();
const code = z.string().regex(/^[1-9]\d{0,19}$/, "Código do Omie inválido.");
const note = z.string().trim().min(10).max(300);

export const suppliersList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: companyOrAll,
        search: z.string().trim().max(120).optional(),
        status: z.enum(["all", "sem_prazo", "com_prazo", "teste", "com_estoque"]).optional(),
        page: z.number().int().min(0).max(1000),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).list(context.supabase, data);
  });

export const supplierDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company, supplierId: code }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).detail(context.supabase, data.companyId, data.supplierId);
  });

export const productSuppliers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company, omieProductId: code }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).ofProduct(context.supabase, data.companyId, data.omieProductId);
  });

export const leadTimeSet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: company,
        supplierId: code,
        omieProductId: code.optional(),
        values: z
          .object({
            leadTimeDays: z.number().int().min(1).max(365),
            minLot: z.number().positive().max(1_000_000).nullable().optional(),
          })
          .strict()
          .nullable(),
        note,
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).setLeadTime(context.supabase, data));

export const preferredSupplierSet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ companyId: company, omieProductId: code, supplierId: code.nullable(), note })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).setPreferred(context.supabase, data));

export const supplierLinkSet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: company,
        omieProductId: code,
        supplierId: code,
        linked: z.boolean(),
        note,
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).setLink(context.supabase, data));

export const supplierSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ companyId: company, text: z.string().trim().min(3).max(120) })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) =>
    (await repo()).search(context.supabase, data.companyId, data.text),
  );

export const supplierRequestImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company }).strict().parse(i))
  .handler(async ({ data, context }) =>
    (await repo()).requestImport(context.supabase, data.companyId),
  );

export const replenishmentPolicies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: companyOrAll }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).policies(context.supabase, data.companyId);
  });

export const replenishmentPolicySet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: company,
        values: z
          .object({
            reviewDays: z.number().int().min(1).max(180),
            serviceLevel: z.union([
              z.literal(0.8),
              z.literal(0.85),
              z.literal(0.9),
              z.literal(0.95),
              z.literal(0.97),
              z.literal(0.98),
              z.literal(0.99),
            ]),
            maxCoverageDays: z.number().int().min(7).max(730).nullable().optional(),
          })
          .strict()
          .nullable(),
        note,
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).setPolicy(context.supabase, data));
