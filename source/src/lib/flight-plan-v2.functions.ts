/**
 * Funções de servidor do Plano de Voo. Quem pode o quê é decidido no banco (flight_plan_internal,
 * migração 0050); aqui só se valida o formato da entrada e se delega ao repositório, carregado
 * apenas no servidor. Respostas são por usuário: nada fica em cache intermediário.
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { InitiativeInput, PlanQuery, TargetChange } from "@/flight-plan/api/contract";

const repo = () => import("./repositories/flight-plan-v2.repository.server");
const noStore = () => setResponseHeader("Cache-Control", "no-store");

const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês inválido.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.");
const channel = z.enum(["varejo", "licitacao"]);
const level = z.enum(["BASE", "ACTIVE", "CHALLENGE"]);
const money = z.number().finite().min(0).max(999_999_999_999.99);

const planQuery = z
  .object({
    companyId: uuid,
    month,
    channel: channel.optional(),
    sellerId: uuid.optional(),
    branchId: uuid.optional(),
    state: z.string().max(4).optional(),
    city: z.string().max(80).optional(),
    category: z.string().max(80).optional(),
  })
  .strict();

/** Tira as chaves vazias (o contrato não aceita "undefined" em campo opcional). */
function toQuery(q: z.infer<typeof planQuery>): PlanQuery {
  const out: PlanQuery = { companyId: q.companyId, month: q.month };
  if (q.channel) out.channel = q.channel;
  if (q.sellerId) out.sellerId = q.sellerId;
  if (q.branchId) out.branchId = q.branchId;
  if (q.state) out.state = q.state;
  if (q.city) out.city = q.city;
  if (q.category) out.category = q.category;
  return out;
}

const targetChange = z
  .object({
    scope: z.enum(["company", "seller"]),
    channel: channel.nullable().optional(),
    sellerId: uuid.optional(),
    level,
    amount: money.nullable(),
  })
  .strict();

const initiative = z
  .object({
    id: uuid.optional(),
    companyId: uuid,
    month,
    title: z.string().trim().min(1).max(160),
    lever: z.enum([
      "CONVERT_QUOTES",
      "REACTIVATE_CUSTOMERS",
      "EXPAND_MIX",
      "PRODUCT_CAMPAIGN",
      "PUBLIC_BIDS",
      "PROSPECTING",
      "OTHER",
    ]),
    ownerUserId: z.string().regex(/^(user|seller):[0-9a-fA-F-]{36}$/, "Responsável inválido."),
    sellerIds: z.array(uuid).max(100),
    dueDate: isoDate,
    expectedAmount: money,
    realizedAmount: money.nullable(),
    status: z.enum(["PLANNED", "IN_PROGRESS", "DONE", "CANCELLED"]),
    alertKey: z.string().max(200).nullable(),
    targetListKind: z
      .enum(["OPEN_QUOTES", "INACTIVE_CUSTOMERS", "LATE_ORDERS", "IDLE_STOCK"])
      .nullable(),
    notes: z.string().max(1000).nullable(),
  })
  .strict();

export const fpBootstrap = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    noStore();
    return (await repo()).bootstrap(context.supabase);
  });

export const fpListSellers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: uuid }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).listSellers(context.supabase, data.companyId);
  });

export const fpGetPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => planQuery.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).getPlan(context.supabase, context.userId, toQuery(data));
  });

export const fpGetSnapshots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => planQuery.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).getSnapshots(context.supabase, context.userId, toQuery(data));
  });

export const fpSetCommit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        query: planQuery.extend({ sellerId: uuid }),
        amount: money.nullable(),
        note: z.string().max(500).nullable(),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    const q = toQuery(data.query);
    await (
      await repo()
    ).setCommit(context.supabase, { ...q, sellerId: data.query.sellerId }, data.amount, data.note);
    return { ok: true };
  });

export const fpGetTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: uuid, month }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).getTargets(context.supabase, data.companyId, data.month);
  });

function toChanges(list: z.infer<typeof targetChange>[]): TargetChange[] {
  return list.map((c) => {
    const out: TargetChange = { scope: c.scope, level: c.level, amount: c.amount };
    if (c.channel !== undefined) out.channel = c.channel;
    if (c.sellerId) out.sellerId = c.sellerId;
    return out;
  });
}

export const fpPreviewTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ companyId: uuid, month, changes: z.array(targetChange).max(3000) })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).previewTargets(
      context.supabase,
      data.companyId,
      data.month,
      toChanges(data.changes),
    );
  });

export const fpSaveTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ companyId: uuid, month, changes: z.array(targetChange).min(1).max(3000) })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).saveTargets(
      context.supabase,
      data.companyId,
      data.month,
      toChanges(data.changes),
    );
  });

export const fpGetYear = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    planQuery
      .omit({ month: true })
      .extend({ year: z.number().int().min(2000).max(2100) })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    const { year, ...rest } = data;
    const q = toQuery({ ...rest, month: `${year}-01` });
    const { month: _month, ...withoutMonth } = q;
    return (await repo()).getYear(context.supabase, { ...withoutMonth, year });
  });

export const fpListInitiatives = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => planQuery.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).listInitiatives(context.supabase, context.userId, toQuery(data));
  });

export const fpSaveInitiative = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => initiative.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    const input: InitiativeInput = { ...data, title: data.title.trim() } as InitiativeInput;
    if (!data.id) delete (input as { id?: string }).id;
    return (await repo()).saveInitiative(context.supabase, input);
  });

export const fpSetInitiativeStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: uuid,
        status: z.enum(["PLANNED", "IN_PROGRESS", "DONE", "CANCELLED"]),
        realizedAmount: money.nullable(),
        note: z.string().max(1000).nullable(),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).setInitiativeStatus(
      context.supabase,
      data.id,
      data.status,
      data.realizedAmount,
      data.note,
    );
  });

export const fpGetTargetLists = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => planQuery.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).getTargetLists(context.supabase, toQuery(data));
  });

export const fpListAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => planQuery.parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).listAlerts(context.supabase, context.userId, toQuery(data));
  });

export const fpSetAlertState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        key: z.string().min(1).max(200),
        state: z.enum(["OPEN", "ACKNOWLEDGED", "ACTION_CREATED", "RESOLVED"]),
        note: z.string().max(1000).nullable(),
        initiativeId: uuid.optional(),
        query: planQuery.optional(),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).setAlertState(
      context.supabase,
      context.userId,
      data.key,
      data.state,
      data.note,
      data.initiativeId,
      data.query ? toQuery(data.query) : undefined,
    );
  });

export const fpGetWeeklyReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ query: planQuery, weekStart: isoDate }).strict().parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).getWeeklyReview(
      context.supabase,
      context.userId,
      toQuery(data.query),
      data.weekStart,
    );
  });

export const fpAddDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({ query: planQuery, weekStart: isoDate, text: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    await (
      await repo()
    ).addDecision(context.supabase, toQuery(data.query), data.weekStart, data.text);
    return { ok: true };
  });

export const fpListHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        companyId: uuid,
        area: z.enum(["visao", "destino", "rota", "correcao"]).optional(),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).listHistory(context.supabase, data.companyId, data.area);
  });
