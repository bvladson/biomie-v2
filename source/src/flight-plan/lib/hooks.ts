import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { flightPlanApi } from "../api";
import type { Channel, Company, Me, PlanQuery } from "../api/contract";
import { useGlobalFilters } from "@/hooks/use-filters";

/** Usuário e empresas (com peso do sábado e canais), carregados uma vez pelo layout do Plano de Voo. */
export interface FlightPlanContextValue {
  me: Me;
  companies: Company[];
}
export const FlightPlanContext = createContext<FlightPlanContextValue | null>(null);

export function useFlightPlanContext(): FlightPlanContextValue {
  const value = useContext(FlightPlanContext);
  if (!value) throw new Error("Plano de Voo fora do layout.");
  return value;
}

/** Recorte da URL que as telas do Plano de Voo leem (canal e vendedor vêm dos filtros globais). */
export interface FpSearch {
  canal?: Channel;
  vendedor?: string;
}

/**
 * Filtros do Plano de Voo = filtros globais do BIOMIE. O canal global é um id; aqui vira
 * "varejo"/"licitacao" (outros canais não têm Plano de Voo e ficam de fora, com aviso no layout).
 */
export function useFilters() {
  const ctx = useFlightPlanContext();
  const g = useGlobalFilters();
  const company = ctx.companies.find((c) => c.id === g.resolved?.company) ?? ctx.companies[0]!;
  const month = g.resolved?.period ?? company.asOf.slice(0, 7);
  const channelName = g.search.channel
    ? Object.entries(company.channels ?? {}).find(([, id]) => id === g.search.channel)?.[0]
    : undefined;
  const channel: Channel | undefined =
    channelName === "varejo" || channelName === "licitacao" ? channelName : undefined;
  const query: PlanQuery = { companyId: company.id, month };
  if (channel) query.channel = channel;
  if (g.search.seller) query.sellerId = g.search.seller;
  if (g.search.branch) query.branchId = g.search.branch;
  if (g.search.state) query.state = g.search.state;
  if (g.search.city) query.city = g.search.city;
  if (g.search.category) query.category = g.search.category;
  const search: FpSearch = {};
  if (channel) search.canal = channel;
  if (g.search.seller) search.vendedor = g.search.seller;
  const set = (patch: Partial<FpSearch>) =>
    g.setFilters({
      ...("vendedor" in patch ? { seller: patch.vendedor } : {}),
      ...("canal" in patch
        ? { channel: patch.canal ? company.channels?.[patch.canal] : undefined }
        : {}),
    });
  return {
    company,
    month,
    query,
    /** Chave de cache por usuário (o protótipo trocava de "persona"). */
    persona: ctx.me.userId,
    set,
    search,
    /** Canal global sem Plano de Voo (ex.: "outros", ou canal de empresa de demonstração). */
    unsupportedChannel: !!g.search.channel && !channel,
    /** Filial, UF, cidade ou categoria: mudam realizado e carteira, não a meta. */
    extraFilters: !!(query.branchId || query.state || query.city || query.category),
  };
}

export const fpKey = (persona: string, ...parts: unknown[]) => ["fp", persona, ...parts];
const PLAN_STALE_MS = 60_000;

export function usePlan(q?: PlanQuery) {
  const f = useFilters();
  const query = q ?? f.query;
  return useQuery({
    queryKey: fpKey(f.persona, "plan", query),
    queryFn: () => flightPlanApi.getPlan(query),
    staleTime: PLAN_STALE_MS,
  });
}

export function useMe() {
  const ctx = useFlightPlanContext();
  return useQuery({
    queryKey: fpKey(ctx.me.userId, "me"),
    queryFn: () => flightPlanApi.me(),
    initialData: ctx.me,
    staleTime: Infinity,
  });
}

export function useSellers() {
  const f = useFilters();
  return useQuery({
    queryKey: fpKey(f.persona, "sellers", f.company.id),
    queryFn: () => flightPlanApi.listSellers(f.company.id),
    staleTime: 5 * 60_000,
  });
}

/** Meses de um trimestre/ano: saem do mesmo plano do mês (FlightPlan.months), sem leitura extra. */
export function usePeriodMonths(months: string[]) {
  const f = useFilters();
  return useQuery({
    queryKey: fpKey(f.persona, "plan", f.query),
    queryFn: () => flightPlanApi.getPlan(f.query),
    staleTime: PLAN_STALE_MS,
    select: (p) => p.months.filter((r) => months.includes(r.month)),
  });
}
