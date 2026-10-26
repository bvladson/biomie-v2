/**
 * OmieClient — the single HTTP layer for the Omie API (server-only usage).
 * Timeout, retry with exponential backoff + jitter, rate-limit handling,
 * pagination validation and safe error messages (never echoes credentials
 * or payloads). Pure fetch: runs on the Worker runtime.
 */

import {
  abortableWait,
  CircuitOpenError,
  OmieRateLimiter,
  getSharedOmieLimiter,
} from "./rate-limiter";

export const OMIE_BASE_URL = "https://app.omie.com.br/api/v1/";

export interface OmieCredentials {
  appKey: string;
  appSecret: string;
}

export interface OmieClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  limiter?: OmieRateLimiter;
  /** Caps throttle waits + attempts + backoff together, including response bodies. */
  maxElapsedMs?: number;
}

export type OmieErrorKind =
  "auth" | "rate_limit" | "timeout" | "network" | "server" | "client" | "incomplete" | "blocked";

export class OmieError extends Error {
  constructor(
    public kind: OmieErrorKind,
    message: string,
    public retriable: boolean,
    public retryAfterMs = 0,
  ) {
    super(message);
    this.name = "OmieError";
  }
}

export interface OmiePage<T> {
  page: number;
  totalPages: number;
  totalRecords: number | null;
  records: T[];
}

const EMPTY_PAGE = /n[aã]o existem registros/i;
const RATE_LIMIT = /(consumo redundante|redundant|bloquead|limite de requisi|too many|aguarde)/i;
const AUTH = /(app_key|app_secret|chave de acesso|n[aã]o autorizad|invalid.*key|acesso negado)/i;

const REDUNDANT = /(consumo redundante|redundant)/i;
// "Já existe uma requisição desse método sendo executada e você pode tentar
// novamente em alguns instantes": Omie still holds the previous call of this
// method for this application (seen right after a fast empty page, 19/10/2026).
const BUSY = /j[aá] existe uma requisi[cç][aã]o desse m[eé]todo/i;
export const OMIE_BUSY_RETRY_MS = 20_000;

/** Stable identity of one exact request; never contains the credentials themselves. */
export function requestFingerprint(
  appKey: string,
  path: string,
  call: string,
  param: Record<string, unknown>,
): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
          )
        : value;
  // FNV-1a of the App Key keeps applications apart without storing the key itself.
  let hash = 0x811c9dc5;
  for (let i = 0; i < appKey.length; i++) {
    hash ^= appKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}|${path}|${call}|${JSON.stringify(stable(param))}`;
}

/** Strips anything that looks like a credential from a message. */
export function redact(message: string, creds?: OmieCredentials): string {
  let m = message;
  if (creds) {
    for (const v of [creds.appKey, creds.appSecret]) if (v) m = m.split(v).join("[redacted]");
  }
  return m.replace(/("?app_(key|secret)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, "$1[redacted]").slice(0, 300);
}

export class OmieClient {
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxRetries: number;
  private baseDelayMs: number;
  private sleep: (ms: number) => Promise<void>;
  private baseUrl: string;
  private limiter: OmieRateLimiter;
  private maxElapsedMs: number;

  constructor(
    private creds: OmieCredentials,
    opts: OmieClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 1_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? OMIE_BASE_URL;
    this.limiter = opts.limiter ?? getSharedOmieLimiter();
    this.maxElapsedMs = opts.maxElapsedMs ?? 120_000;
  }

  /**
   * One API call with retries, through the rate limiter.
   * 425 opens the circuit for this App Key + method (no retry);
   * 429 retries with exponential backoff + jitter; permanent errors never retry.
   */
  async call(
    path: string,
    call: string,
    param: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let attempt = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.maxElapsedMs);
    // Identical requests (same method + params) are spaced by the limiter.
    const fingerprint = requestFingerprint(this.creds.appKey, path, call, param);
    try {
      for (;;) {
        try {
          return await this.limiter.run(
            this.creds.appKey,
            call,
            async () => {
              const body = await this.once(path, call, param, controller.signal);
              // Empty page: Omie still holds this call a few seconds; the next one waits longer.
              if (body["__empty"]) this.limiter.noteEmptyPage(this.creds.appKey, call);
              return body;
            },
            controller.signal,
            fingerprint,
          );
        } catch (e) {
          if (controller.signal.aborted)
            throw new OmieError(
              "timeout",
              "Orçamento de tempo da chamada Omie esgotado; retome pelo checkpoint.",
              true,
            );
          if (e instanceof CircuitOpenError) throw new OmieError("blocked", e.message, false);
          const err =
            e instanceof OmieError
              ? e
              : new OmieError("network", "Falha de rede ao chamar o Omie.", true);
          if (["auth", "blocked", "rate_limit", "client", "server"].includes(err.kind))
            this.limiter.recordFailure(
              this.creds.appKey,
              err.kind as "auth" | "blocked" | "rate_limit" | "client" | "server",
            );
          if (err.kind === "blocked") {
            this.limiter.openCircuit(this.creds.appKey, call);
            throw err;
          }
          if (!err.retriable || attempt >= this.maxRetries) throw err;
          const factor = err.kind === "rate_limit" ? 4 : 1;
          const base = Math.min(60_000, this.baseDelayMs * factor * 2 ** attempt);
          // Up to 25% jitter so retries from several jobs do not align.
          const delay = Math.max(err.retryAfterMs, base + Math.floor(Math.random() * base * 0.25));
          attempt++;
          // Every retried fault is visible in the logs (messages are already redacted).
          console.warn(
            `omie retry call=${call} kind=${err.kind} attempt=${attempt} wait_ms=${delay}: ${err.message.slice(0, 160)}`,
          );
          await abortableWait(this.sleep, delay, controller.signal);
        }
      }
    } catch (error) {
      if (controller.signal.aborted)
        throw new OmieError(
          "timeout",
          "Orçamento de tempo da chamada Omie esgotado; retome pelo checkpoint.",
          true,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async once(
    path: string,
    call: string,
    param: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call,
          app_key: this.creds.appKey,
          app_secret: this.creds.appSecret,
          param: [param],
        }),
        signal: ctrl.signal,
        redirect: "error",
      });
      // The timeout includes the body, not just receipt of HTTP headers.
      text = await res.text();
    } catch (e) {
      if ((e as Error)?.name === "AbortError")
        throw new OmieError(
          "timeout",
          `Tempo esgotado (${this.timeoutMs / 1000}s) ao chamar o Omie.`,
          true,
        );
      throw new OmieError("network", "Falha de rede ao chamar o Omie.", true);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const fault =
      body && typeof body["faultstring"] === "string" ? (body["faultstring"] as string) : null;
    if (res.ok && body && !fault) return body;

    const msg = redact(fault ?? `HTTP ${res.status}`, this.creds);
    if (fault && EMPTY_PAGE.test(fault)) return { __empty: true };
    if (res.status === 425)
      throw new OmieError(
        "blocked",
        `Omie bloqueou temporariamente este método (425): ${msg}`,
        false,
      );
    if (fault && BUSY.test(fault)) {
      // Space the next calls of this method, so one busy answer does not become three per cycle.
      this.limiter.noteBusy(this.creds.appKey, call);
      throw new OmieError(
        "rate_limit",
        `Omie ainda processa outra requisição deste método: ${msg}`,
        true,
        OMIE_BUSY_RETRY_MS,
      );
    }
    if (res.status === 429 || (fault && RATE_LIMIT.test(fault))) {
      const retry = res.headers.get("retry-after");
      const retryMs = retry
        ? /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now()
        : 0;
      // "Consumo redundante": repeating the same query inside 60 s extends the block.
      const minimum = fault && REDUNDANT.test(fault) ? 61_000 : 0;
      throw new OmieError(
        "rate_limit",
        `Limite de requisições do Omie: ${msg}`,
        true,
        Math.max(minimum, Number.isFinite(retryMs) ? Math.max(0, Math.min(300_000, retryMs)) : 0),
      );
    }
    if (res.status === 401 || res.status === 403 || (fault && AUTH.test(fault)))
      throw new OmieError("auth", `Credenciais recusadas pelo Omie: ${msg}`, false);
    if (res.status >= 500 && !fault)
      throw new OmieError("server", `Erro no servidor do Omie: ${msg}`, true);
    if (!body) throw new OmieError("incomplete", "Resposta do Omie não é JSON válido.", true);
    throw new OmieError("client", `Omie recusou a requisição: ${msg}`, false);
  }

  /** Fetches one page and validates pagination metadata. */
  async listPage<T>(
    path: string,
    call: string,
    params: Record<string, unknown>,
    listKeys: string[],
  ): Promise<OmiePage<T>> {
    const page = Number(params["pagina"] ?? params["nPagina"] ?? 1);
    const body = await this.call(path, call, params);
    if (body["__empty"]) return { page, totalPages: page - 1, totalRecords: 0, records: [] };
    const key = listKeys.find((k) => Array.isArray(body[k]));
    const totalPages = Number(body["total_de_paginas"] ?? body["nTotPaginas"]);
    const reportedPage = body["pagina"] ?? body["nPagina"];
    const declaredTotal = Number(body["total_de_registros"] ?? body["nTotRegistros"]);
    // Omie answers an empty period with pagina=0, total_de_paginas=0 and an empty
    // list (observed on ListarNF, ListarContasReceber and ListarMovimentos).
    if (
      page === 1 &&
      totalPages === 0 &&
      declaredTotal === 0 &&
      (!key || (body[key] as unknown[]).length === 0) &&
      (reportedPage === undefined || Number(reportedPage) === 0 || Number(reportedPage) === 1)
    ) {
      // Same as the "não existem registros" fault: Omie still holds this call for a few seconds.
      this.limiter.noteEmptyPage(this.creds.appKey, call);
      return { page, totalPages: 0, totalRecords: 0, records: [] };
    }
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !key ||
      !Number.isInteger(totalPages) ||
      totalPages < 0 ||
      (reportedPage !== undefined && Number(reportedPage) !== page)
    )
      throw new OmieError(
        "incomplete",
        `Resposta incompleta do Omie (${call}, página ${page}).`,
        true,
      );
    const records = body[key] as T[];
    if (
      (records.length > 0 && (totalPages === 0 || page > totalPages)) ||
      (records.length === 0 && page < totalPages)
    )
      throw new OmieError(
        "incomplete",
        `Paginação inconsistente do Omie (${call}, página ${page}).`,
        false,
      );
    const declared = Number(body["registros"] ?? body["nRegistros"]);
    if (Number.isFinite(declared) && declared !== records.length)
      throw new OmieError(
        "incomplete",
        `Página ${page} incompleta: declarou ${declared} registros, recebeu ${records.length}.`,
        true,
      );
    const total = Number(body["total_de_registros"] ?? body["nTotRegistros"]);
    return { page, totalPages, totalRecords: Number.isFinite(total) ? total : null, records };
  }
}
