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
  forecastFacts,
  headerLine,
  historyFacts,
  opportunityFacts,
  overviewFacts,
  planFacts,
  revenueFacts,
  sellersFacts,
  stockFacts,
  trendFacts,
} from "./facts-format";

type Db = SupabaseClient<Database>;

export interface FactsBundle {
  lines: string[];
  companyName: string;
  periodLabel: string;
  asOf: string;
}

/**
 * O contexto do modelo rápido é 2.048 tokens: os fatos ficam em no máximo 14 linhas / ~2.400
 * caracteres. A análise profunda roda com 4.096 e aceita mais (o gateway corta em 4.500 caracteres
 * de entrada, contando a pergunta e as instruções).
 */
export function clampFacts(lines: string[], deep = false): string[] {
  const maxLines = deep ? 34 : 14;
  const maxChars = deep ? 3600 : 2400;
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (out.length >= maxLines || size + line.length > maxChars) break;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

/** Junta pacotes sem repetir linha (a tendência e o ritmo compartilham algumas). */
function merge(...packs: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pack of packs)
    for (const line of pack) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
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

/**
 * Monta os fatos de uma intenção do catálogo. Erros das funções de leitura sobem como estão
 * (mensagens amigáveis). Com `deep`, a ANÁLISE PROFUNDA recebe mais contexto: no estoque entram as
 * oportunidades, e no comercial entram tendência, ritmo, indicadores e o ranking de vendedores.
 */
export async function buildFacts(
  db: Db,
  userId: string,
  intent: AiIntent,
  topic: AiTopic,
  companyId: string,
  filters: AiFilters,
  deep = false,
): Promise<FactsBundle> {
  const name = await companyName(db, companyId);

  if (intent === "estoque_parado" || (intent === "explicar_tela" && topic === "estoque")) {
    const intel = await import("@/lib/repositories/stock-intel.repository.server");
    const [ov, asOf, ops] = await Promise.all([
      intel.overview(db, companyId),
      dataAsOf(db, companyId),
      deep
        ? intel.opportunities(db, { companyId, page: 1 }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const periodLabel = "estoque de hoje";
    const body = ops
      ? merge(stockFacts(ov), opportunityFacts(ops.rows, ops.total))
      : stockFacts(ov);
    return {
      lines: [
        headerLine(name, periodLabel, ov.status.runs[0]?.asOf ?? asOf),
        ...clampFacts(body, deep),
      ],
      companyName: name,
      periodLabel,
      asOf,
    };
  }

  if (intent === "oportunidades_estoque") {
    const intel = await import("@/lib/repositories/stock-intel.repository.server");
    const [ops, asOf, ov] = await Promise.all([
      intel.opportunities(db, { companyId, page: 1 }),
      dataAsOf(db, companyId),
      deep ? intel.overview(db, companyId).catch(() => null) : Promise.resolve(null),
    ]);
    const periodLabel = "estoque de hoje";
    const body = ov
      ? merge(opportunityFacts(ops.rows, ops.total), stockFacts(ov))
      : opportunityFacts(ops.rows, ops.total);
    return {
      lines: [headerLine(name, periodLabel, asOf), ...clampFacts(body, deep)],
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
    const body = breakdownFacts(dim, b.rows, b.total);
    if (deep) {
      // Ranking + contexto do mês: dá para ligar a concentração ao ritmo e à meta.
      const extra = await planFor(db, userId, companyId, filters).catch(() => null);
      if (extra) {
        return {
          lines: [
            headerLine(name, periodLabelOf(q.period), asOf),
            ...clampFacts(merge(body, trendFacts(extra.plan)), true),
          ],
          companyName: name,
          periodLabel: periodLabelOf(q.period),
          asOf,
        };
      }
    }
    return {
      lines: [headerLine(name, periodLabelOf(q.period), asOf), ...clampFacts(body, deep)],
      companyName: name,
      periodLabel: periodLabelOf(q.period),
      asOf,
    };
  }

  // Demais intenções saem do Plano de Voo do mês (uma leitura só, com metas e conclusões).
  const { plan, month, asOf } = await planFor(db, userId, companyId, filters);
  const periodLabel = periodLabelOf(month);
  const PLAN_PACKS: Partial<Record<AiIntent, (p: typeof plan) => string[]>> = {
    ritmo_plano: planFacts,
    previsao_mes: forecastFacts,
    historico_meses: historyFacts,
    tendencia: trendFacts,
    faturamento_periodo: revenueFacts,
    comparacao_periodos: comparisonFacts,
    ranking_vendedores: sellersFacts,
  };
  const pack =
    PLAN_PACKS[intent] ??
    (intent === "explicar_tela" && topic === "vendedores" ? sellersFacts : overviewFacts);
  // Na análise profunda o assunto pedido vem primeiro e o resto do mês entra como contexto.
  const body = deep
    ? merge(pack(plan), trendFacts(plan), planFacts(plan), revenueFacts(plan), sellersFacts(plan))
    : pack(plan);
  return {
    lines: [headerLine(name, periodLabel, asOf), ...clampFacts(body, deep)],
    companyName: name,
    periodLabel,
    asOf,
  };
}
