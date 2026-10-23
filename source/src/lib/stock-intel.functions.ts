/**
 * Funções de servidor da inteligência do Estoque (migração 0044). Toda decisão de permissão é do
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
