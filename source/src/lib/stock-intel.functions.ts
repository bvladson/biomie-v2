/**
 * Funções de servidor da inteligência do Estoque (migrações 0044 a 0048). Toda decisão de permissão é do
 * banco; aqui só se valida o formato da entrada. Respostas não ficam em cache intermediário.
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const repo = () => import("./repositories/stock-intel.repository.server");
const noStore = () => setResponseHeader("Cache-Control", "no-store");

const company = z.union([z.literal("all"), z.string().uuid()]);
const curveWindow = z.enum(["30d", "90d", "180d", "12m"]);
const state = z.enum([
  "novo",
  "historico_insuficiente",
  "sem_venda_janela",
  "baixo_giro",
  "possivel_excesso",
  "possivel_obsolescencia",
  "saudavel",
  "risco_ruptura",
  "sem_saldo",
]);
const band = z.enum(["0-30", "31-60", "61-90", "91-180", "181-365", "365+", "insuficiente"]);
const filters = z
  .object({
    companyId: company,
    state: state.optional(),
    flag: z
      .string()
      .regex(/^[a-z_]{3,40}$/)
      .optional(),
    curve: z.enum(["A", "B", "C", "D"]).optional(),
    band: band.optional(),
    minIdle: z
      .union([z.literal(30), z.literal(60), z.literal(90), z.literal(180), z.literal(365)])
      .optional(),
    search: z.string().trim().max(120).optional(),
    rec: z
      .string()
      .regex(/^[a-z_]{3,40}$/)
      .optional(),
    withAlerts: z.boolean().optional(),
    family: z.string().trim().min(1).max(120).optional(),
    sortBy: z.enum(["priority", "capital", "daysWithoutSale", "coverageDays", "name"]).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
  })
  .strict();
// A tela pede páginas (0+); o filtro inteiro só sai pela exportação, que monta o CSV no servidor.
const query = filters.extend({ page: z.number().int().min(0).max(1000) }).strict();

export const intelStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    noStore();
    return (await repo()).status(context.supabase);
  });

export const intelOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ companyId: company, window: curveWindow.optional() }).strict().parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).overview(context.supabase, data.companyId, data.window);
  });

export const intelProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => query.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).products(context.supabase, data);
  });

export const intelProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ companyId: z.string().uuid(), omieProductId: z.string().regex(/^[^:]{1,40}$/) })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).product(context.supabase, data.companyId, data.omieProductId);
  });

export const intelPareto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ companyId: z.string().uuid(), window: curveWindow.optional() }).strict().parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).pareto(context.supabase, data.companyId, data.window);
  });

export const intelExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => filters.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).exportCsv(context.supabase, data);
  });

// ---------------------------------------------------------------- fase 3: alertas
const page = z.number().int().min(0).max(1000);
const omie = z.string().regex(/^[^:]{1,40}$/);
const severity = z.enum(["alta", "media", "baixa", "info"]);

export const intelAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: company,
        status: z.enum(["open", "resolved", "all"]).optional(),
        severity: severity.optional(),
        kind: z
          .string()
          .regex(/^[a-z_]{3,40}$/)
          .optional(),
        onlyNew: z.boolean().optional(),
        search: z.string().trim().max(120).optional(),
        omieProductId: omie.optional(),
        page,
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).alerts(context.supabase, data);
  });

export const intelAckAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ alertId: z.string().uuid(), note: z.string().trim().max(300).nullable() })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).ackAlert(context.supabase, data.alertId, data.note || null);
  });

// ---------------------------------------------------------------- fase 5: reposição e grupo
const replenishmentFilters = z
  .object({
    companyId: company,
    status: z
      .enum([
        "comprar",
        "nao_comprar",
        "aguardar",
        "sem_prazo",
        "sem_previsao",
        "sem_demanda",
        "all",
      ])
      .optional(),
    search: z.string().trim().max(120).optional(),
  })
  .strict();

export const intelReplenishment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => replenishmentFilters.extend({ page }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).replenishment(context.supabase, data);
  });

export const intelReplenishmentExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => replenishmentFilters.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).exportReplenishmentCsv(context.supabase, data);
  });

export const intelReplenishmentParams = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).replenishmentParams(context.supabase, data.companyId);
  });

export const intelSetReplenishment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: z.string().uuid(),
        scope: z.enum(["empresa", "familia", "produto"]),
        key: z.string().trim().max(120),
        values: z
          .object({
            leadTimeDays: z.number().int().min(1).max(365),
            reviewDays: z.number().int().min(1).max(180).optional(),
            serviceLevel: z
              .union([
                z.literal(0.8),
                z.literal(0.85),
                z.literal(0.9),
                z.literal(0.95),
                z.literal(0.97),
                z.literal(0.98),
                z.literal(0.99),
              ])
              .optional(),
            minLot: z.number().positive().max(1000000).nullable().optional(),
            maxCoverageDays: z.number().int().min(7).max(730).nullable().optional(),
          })
          .strict()
          .nullable(),
        reason: z.string().trim().min(10).max(300),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).setReplenishment(context.supabase, data);
  });

export const intelOpportunities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: company,
        omieProductId: omie.optional(),
        search: z.string().trim().max(120).optional(),
        page,
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).opportunities(context.supabase, data);
  });

export const intelPriceBasis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).priceBasis(context.supabase, data.companyId);
  });

export const intelMatrix = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).matrix(context.supabase, data.companyId);
  });
