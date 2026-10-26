/**
 * Filtros da Inteligência no endereço. As chaves são próprias desta tela (em português) porque o
 * BIOMIE mantém os parâmetros do endereço ao navegar e o filtro global já usa "state" (UF) e
 * "category". Valor fora da lista é descartado, nunca adivinhado.
 */
import type { ClassifiedCurve, CompanyFilter } from "../api/contract";
import type {
  IntelBand,
  IntelMinIdle,
  IntelQuery,
  IntelSort,
  IntelState,
} from "../api/intel-contract";
import { BAND_ORDER, FLAG_LABELS, MIN_IDLE, STATE_ORDER } from "./intel";
import { REC_FILTERS } from "./intel-insights";

/** Abas da tela: painel (fases 1–2), alertas (3), reposição (5) e entre empresas (5). */
export type IntelTab = "painel" | "alertas" | "reposicao" | "grupo";
export const TABS: readonly IntelTab[] = ["painel", "alertas", "reposicao", "grupo"];

export interface IntelFilters {
  state?: IntelState | undefined;
  flag?: string | undefined;
  curve?: ClassifiedCurve | undefined;
  band?: IntelBand | undefined;
  minIdle?: IntelMinIdle | undefined;
  q?: string | undefined;
  rec?: string | undefined;
  alerts?: boolean | undefined;
  sort?: IntelSort | undefined;
  dir?: "asc" | "desc" | undefined;
  page?: number | undefined;
}

export interface IntelSearch {
  estado?: IntelState | undefined;
  sinal?: string | undefined;
  curva?: ClassifiedCurve | undefined;
  faixa?: IntelBand | undefined;
  semVenda?: IntelMinIdle | undefined;
  busca?: string | undefined;
  recomendacao?: string | undefined;
  comAlerta?: boolean | undefined;
  ordem?: IntelSort | undefined;
  sentido?: "asc" | "desc" | undefined;
  pagina?: number | undefined;
  aba?: IntelTab | undefined;
}

const KEYS = {
  state: "estado",
  flag: "sinal",
  curve: "curva",
  band: "faixa",
  minIdle: "semVenda",
  q: "busca",
  rec: "recomendacao",
  alerts: "comAlerta",
  sort: "ordem",
  dir: "sentido",
  page: "pagina",
} as const satisfies Record<keyof IntelFilters, keyof IntelSearch>;

const SORTS: readonly IntelSort[] = [
  "priority",
  "capital",
  "daysWithoutSale",
  "coverageDays",
  "name",
];
const CURVES: readonly ClassifiedCurve[] = ["A", "B", "C", "D"];

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export function validateIntelSearch(raw: Record<string, unknown>): IntelSearch {
  const busca = typeof raw["busca"] === "string" ? raw["busca"].trim() : "";
  const pagina = raw["pagina"];
  const sinal = raw["sinal"];
  return {
    estado: pick(raw["estado"], STATE_ORDER),
    sinal: typeof sinal === "string" && Object.hasOwn(FLAG_LABELS, sinal) ? sinal : undefined,
    curva: pick(raw["curva"], CURVES),
    faixa: pick(raw["faixa"], BAND_ORDER),
    semVenda: MIN_IDLE.find((n) => n === raw["semVenda"]),
    busca: busca && busca.length <= 120 ? busca : undefined,
    recomendacao: pick(raw["recomendacao"], REC_FILTERS),
    comAlerta: raw["comAlerta"] === true ? true : undefined,
    ordem: pick(raw["ordem"], SORTS),
    sentido: raw["sentido"] === "asc" || raw["sentido"] === "desc" ? raw["sentido"] : undefined,
    pagina:
      typeof pagina === "number" && Number.isInteger(pagina) && pagina > 0 && pagina <= 1000
        ? pagina
        : undefined,
    aba: pick(raw["aba"], TABS),
  };
}

export function fromSearch(s: IntelSearch): IntelFilters {
  return {
    state: s.estado,
    flag: s.sinal,
    curve: s.curva,
    band: s.faixa,
    minIdle: s.semVenda,
    q: s.busca,
    rec: s.recomendacao,
    alerts: s.comAlerta,
    sort: s.ordem,
    dir: s.sentido,
    page: s.pagina,
  };
}

/** Só as chaves presentes na mudança; undefined tira a chave do endereço. */
export function toSearch(patch: Partial<IntelFilters>): Partial<IntelSearch> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof IntelFilters)[]) out[KEYS[key]] = patch[key];
  return out as Partial<IntelSearch>;
}

/** Limpa todos os filtros da lista (para começar de um card ou de uma faixa do radar). */
export const CLEAR: Required<{ [K in keyof IntelFilters]: undefined }> = {
  state: undefined,
  flag: undefined,
  curve: undefined,
  band: undefined,
  minIdle: undefined,
  q: undefined,
  rec: undefined,
  alerts: undefined,
  sort: undefined,
  dir: undefined,
  page: undefined,
};

/** Consulta da lista: prioridade decrescente quando ninguém escolheu outra ordem. */
export function toQuery(companyId: CompanyFilter, f: IntelFilters): IntelQuery {
  return {
    companyId,
    state: f.state,
    flag: f.flag,
    curve: f.curve,
    band: f.band,
    minIdle: f.minIdle,
    search: f.q || undefined,
    rec: f.rec,
    withAlerts: f.alerts || undefined,
    sortBy: f.sort ?? "priority",
    sortDir: f.dir ?? "desc",
    page: f.page ?? 0,
  };
}

export const hasFilters = (f: IntelFilters) =>
  Boolean(f.state || f.flag || f.curve || f.band || f.minIdle || f.q || f.rec || f.alerts);
