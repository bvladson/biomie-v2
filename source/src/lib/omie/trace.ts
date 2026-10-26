/**
 * Rastreio das chamadas ao Omie para testes de operação (homologação): horário, método, resultado,
 * registros e duração de cada chamada. Só o que o teste precisa: nunca credenciais, nunca valores dos
 * registros; dos parâmetros, só página e datas de filtro (lista fechada).
 */

export type TraceOutcome =
  | "ok" // página com registros
  | "empty-list" // período vazio respondido com lista vazia (pagina=0, total_de_paginas=0)
  | "empty-fault" // período vazio respondido com a falha "não existem registros"
  | "busy" // "já existe uma requisição desse método sendo executada"
  | "redundant" // "consumo redundante"
  | "blocked" // HTTP 425 / bloqueio do Omie
  | "fault" // outra falha do Omie
  | "http" // erro HTTP sem falha do Omie
  | "not-json"
  | "network";

export interface TraceEvent {
  event: "omie_call";
  call: string;
  params: Record<string, string | number>;
  status: number | null;
  outcome: TraceOutcome;
  records: number | null;
  startedAt: string;
  ms: number;
}

const EMPTY = /n[aã]o existem registros/i;
const BUSY = /j[aá] existe uma requisi[cç][aã]o desse m[eé]todo/i;
const REDUNDANT = /(consumo redundante|redundant)/i;
const BLOCKED = /bloquead/i;
// Só estes parâmetros entram no rastro: página, tamanho da página e datas de filtro.
const SAFE_PARAM =
  /^(pagina|nPagina|registros_por_pagina|nRegPorPagina|filtrar_por_[a-z_]+_(de|ate)|dDt[A-Za-z]+(De|Ate))$/;

export function traceParams(param: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!param || typeof param !== "object" || Array.isArray(param)) return out;
  for (const [key, value] of Object.entries(param as Record<string, unknown>)) {
    if (!SAFE_PARAM.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && /^[0-9/ -]{1,10}$/.test(value)) out[key] = value;
  }
  return out;
}

export function classifyOmieAnswer(
  status: number,
  text: string,
): { outcome: TraceOutcome; records: number | null } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { outcome: status === 425 ? "blocked" : "not-json", records: null };
  }
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const fault = typeof b["faultstring"] === "string" ? (b["faultstring"] as string) : null;
  if (status === 425) return { outcome: "blocked", records: null };
  if (fault) {
    if (EMPTY.test(fault)) return { outcome: "empty-fault", records: 0 };
    if (BUSY.test(fault)) return { outcome: "busy", records: null };
    if (REDUNDANT.test(fault)) return { outcome: "redundant", records: null };
    if (BLOCKED.test(fault)) return { outcome: "blocked", records: null };
    return { outcome: "fault", records: null };
  }
  if (status >= 400) return { outcome: "http", records: null };
  const list = Object.values(b).find(Array.isArray) as unknown[] | undefined;
  const records = list ? list.length : null;
  const pages = Number(b["total_de_paginas"] ?? b["nTotPaginas"]);
  if (records === 0 && pages === 0) return { outcome: "empty-list", records: 0 };
  return { outcome: "ok", records };
}

/** fetch que registra cada chamada ao Omie (as demais passam direto). */
export function traceFetch(
  realFetch: typeof fetch,
  log: (event: TraceEvent) => void,
  now: () => number = Date.now,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("omie.com.br")) return realFetch(input, init);
    let call = "?";
    let params: Record<string, string | number> = {};
    try {
      const body = JSON.parse(String(init?.body ?? "{}")) as { call?: unknown; param?: unknown[] };
      if (typeof body.call === "string" && /^[A-Za-z]{3,60}$/.test(body.call)) call = body.call;
      params = traceParams(Array.isArray(body.param) ? body.param[0] : undefined);
    } catch {
      /* corpo fora do padrão: registra só o resultado */
    }
    const t0 = now();
    const startedAt = new Date(t0).toISOString();
    try {
      const res = await realFetch(input, init);
      const { outcome, records } = classifyOmieAnswer(res.status, await res.clone().text());
      log({
        event: "omie_call",
        call,
        params,
        status: res.status,
        outcome,
        records,
        startedAt,
        ms: now() - t0,
      });
      return res;
    } catch (error) {
      log({
        event: "omie_call",
        call,
        params,
        status: null,
        outcome: "network",
        records: null,
        startedAt,
        ms: now() - t0,
      });
      throw error;
    }
  }) as typeof fetch;
}
