// Busca dos fatos do assistente: SEMPRE pelas funções que as telas já usam, com a sessão do usuário
// (RLS decide o que cada um vê; vendedor só enxerga os próprios números). Nada novo é calculado aqui:
// os pacotes viram linhas em src/lib/ai/facts-format.ts e a IA só redige.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnalyticsQuery } from "@/domain/filters";
import { monthLabel } from "@/domain/format";
import type { PlanQuery } from "@/flight-plan/api/contract";
import type { AiFilters, AiIntent, AiTopic } from "./contract";
import {
  breakdownFacts,
  comparisonFacts,
  headerLine,
  opportunityFacts,
  overviewFacts,
  planFacts,
  revenueFacts,
  sellersFacts,
  stockFacts,
} from "./facts-format";

type Db = SupabaseClient<Database>;

export interface FactsBundle {
  lines: string[];
  companyName: string;
  periodLabel: string;
  asOf: string;
}

/** O contexto do modelo é 2.048 tokens: os fatos ficam em no máximo 14 linhas / ~2.400 caracteres. */
export function clampFacts(lines: string[]): string[] {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (out.length >= 14 || size + line.length > 2400) break;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function periodLabelOf(period: string): string {
  if (MONTH_RE.test(period)) {
    const [y, m] = period.split("-").map(Number);
    return monthLabel(y!, m!);
  }
  return `período ${period}`;
}

async function companyName(db: Db, companyId: string): Promise<string> {
  const { data } = await db.from("companies").select("name").eq("id", companyId).maybeSingle();
  return data?.name ?? "empresa";
}

async function dataAsOf(db: Db, companyId: string): Promise<string> {
  const { data, error } = await db.rpc("data_as_of", { p_company: companyId });
  if (error || typeof data !== "string")
    throw new Error("Não foi possível ler a data de referência.");
  return data;
}

async function planFor(db: Db, userId: string, companyId: string, filters: AiFilters) {
  const repo = await import("@/lib/repositories/flight-plan-v2.repository.server");
  const asOf = await dataAsOf(db, companyId);
  const month = filters.period && MONTH_RE.test(filters.period) ? filters.period : asOf.slice(0, 7);
  const q: PlanQuery = { companyId, month };
  if (filters.seller) q.sellerId = filters.seller;
  if (filters.branch) q.branchId = filters.branch;
  if (filters.state) q.state = filters.state;
  if (filters.city) q.city = filters.city;
  if (filters.category) q.category = filters.category;
  if (filters.channel) {
    // O filtro global guarda o id do canal; o Plano de Voo usa o nome oficial.
    const { companies } = await repo.bootstrap(db);
    const channels = companies.find((c) => c.id === companyId)?.channels ?? {};
    const name = (Object.entries(channels) as [string, string][]).find(
      ([, id]) => id === filters.channel,
    )?.[0];
    if (name === "varejo" || name === "licitacao") q.channel = name;
  }
  return { plan: await repo.getPlan(db, userId, q), month, asOf };
}

function analyticsQuery(
  companyId: string,
  filters: AiFilters,
  fallbackPeriod: string,
): AnalyticsQuery {
  return {
    company: companyId,
    period: filters.period ?? fallbackPeriod,
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.branch ? { branch: filters.branch } : {}),
    ...(filters.seller ? { seller: filters.seller } : {}),
    ...(filters.state ? { state: filters.state } : {}),
    ...(filters.city ? { city: filters.city } : {}),
    ...(filters.category ? { category: filters.category } : {}),
  } as AnalyticsQuery;
}

/** Monta os fatos de uma intenção do catálogo. Erros das funções de leitura sobem como estão (mensagens amigáveis). */
export async function buildFacts(
  db: Db,
  userId: string,
  intent: AiIntent,
  topic: AiTopic,
  companyId: string,
  filters: AiFilters,
): Promise<FactsBundle> {
  const name = await companyName(db, companyId);

  if (intent === "estoque_parado" || (intent === "explicar_tela" && topic === "estoque")) {
    const intel = await import("@/lib/repositories/stock-intel.repository.server");
    const [ov, asOf] = await Promise.all([intel.overview(db, companyId), dataAsOf(db, companyId)]);
    const periodLabel = "estoque de hoje";
    return {
      lines: [
        headerLine(name, periodLabel, ov.status.runs[0]?.asOf ?? asOf),
        ...clampFacts(stockFacts(ov)),
      ],
      companyName: name,
      periodLabel,
      asOf,
    };
  }

  if (intent === "oportunidades_estoque") {
    const intel = await import("@/lib/repositories/stock-intel.repository.server");
    const [ops, asOf] = await Promise.all([
      intel.opportunities(db, { companyId, page: 1 }),
      dataAsOf(db, companyId),
    ]);
    const periodLabel = "estoque de hoje";
    return {
      lines: [
        headerLine(name, periodLabel, asOf),
        ...clampFacts(opportunityFacts(ops.rows, ops.total)),
      ],
      companyName: name,
      periodLabel,
      asOf,
    };
  }

  if (intent === "ranking_clientes" || intent === "ranking_produtos") {
    const sales = await import("@/lib/repositories/sales.repository.server");
    const asOf = await dataAsOf(db, companyId);
    const dim = intent === "ranking_clientes" ? ("customer" as const) : ("product" as const);
    const q = analyticsQuery(companyId, filters, asOf.slice(0, 7));
    const b = await sales.getSalesBreakdown(db, q, dim);
    return {
      lines: [
        headerLine(name, periodLabelOf(q.period), asOf),
        ...clampFacts(breakdownFacts(dim, b.rows, b.total)),
      ],
      companyName: name,
      periodLabel: periodLabelOf(q.period),
      asOf,
    };
  }

  // Demais intenções saem do Plano de Voo do mês (uma leitura só, com metas e conclusões).
  const { plan, month, asOf } = await planFor(db, userId, companyId, filters);
  const periodLabel = periodLabelOf(month);
  const body =
    intent === "ritmo_plano"
      ? planFacts(plan)
      : intent === "faturamento_periodo"
        ? revenueFacts(plan)
        : intent === "comparacao_periodos"
          ? comparisonFacts(plan)
          : intent === "ranking_vendedores" ||
              (intent === "explicar_tela" && topic === "vendedores")
            ? sellersFacts(plan)
            : overviewFacts(plan);
  return {
    lines: [headerLine(name, periodLabel, asOf), ...clampFacts(body)],
    companyName: name,
    periodLabel,
    asOf,
  };
}
