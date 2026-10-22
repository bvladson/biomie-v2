/**
 * Funções de servidor do Estoque. Toda decisão de permissão é do banco (stock_internal); aqui
 * só se valida o formato da entrada e se delega ao repositório, carregado apenas no servidor.
 * Respostas com custo não ficam em cache intermediário.
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const repo = () => import("./repositories/stock.repository.server");
const noStore = () => setResponseHeader("Cache-Control", "no-store");

const company = z.union([z.literal("all"), z.string().uuid()]);
const curve = z.enum(["A", "B", "C", "D", "U"]);
const filters = z
  .object({
    companyId: company,
    search: z.string().max(120).optional(),
    curve: z.union([curve, z.literal("all")]).optional(),
    locationCode: z.string().max(40).optional(),
    family: z.string().max(120).optional(),
    onlyNegative: z.boolean().optional(),
    hideZero: z.boolean().optional(),
    belowMin: z.boolean().optional(),
    productId: z.string().uuid().optional(),
    sortBy: z.enum(["costValue", "physicalQty", "name", "sku"]).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
  })
  .strict();
const percent = z.number().int().min(0).max(100);
const scenario = z
  .object({
    cuts: z.object({ A: percent, B: percent, C: percent, D: percent }).strict(),
    discount: z.number().int().min(0).max(70),
  })
  .strict();
const positionId = z
  .string()
  .regex(/^[0-9a-fA-F-]{36}:[^:]{1,40}:[^:]{1,40}$/, "Posição inválida.");

export const stockCapabilities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await repo()).capabilities(context.supabase));

export const stockOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).overview(context.supabase, data.companyId);
  });

export const stockPositions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    filters
      .extend({ page: z.number().int().min(0).max(1000) })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).positions(context.supabase, data);
  });

export const stockFilterOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company }).strict().parse(i))
  .handler(async ({ data, context }) =>
    (await repo()).filterOptions(context.supabase, data.companyId),
  );

export const stockSetCurve = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ positionIds: z.array(positionId).min(1).max(5000), curve })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) =>
    (await repo()).setCurve(context.supabase, data.positionIds, data.curve),
  );

export const stockSimulationBase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: company }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).simulationBase(context.supabase, data.companyId);
  });

export const stockListScenarios = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await repo()).listScenarios(context.supabase));

export const stockSaveScenario = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    scenario
      .extend({ name: z.string().trim().min(1).max(60), id: z.string().uuid().optional() })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).saveScenario(context.supabase, data));

export const stockDeleteScenario = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).strict().parse(i))
  .handler(async ({ data, context }) => (await repo()).deleteScenario(context.supabase, data.id));

export const stockExportCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("positions"), query: filters }).strict(),
        z.object({ kind: z.literal("simulation"), companyId: company, scenario }).strict(),
      ])
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).exportCsv(context.supabase, data);
  });

export const stockRequestRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: z.string().uuid() }).strict().parse(i))
  .handler(async ({ data, context }) =>
    (await repo()).requestRefresh(context.supabase, data.companyId),
  );
