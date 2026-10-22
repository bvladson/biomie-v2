/**
 * Leitura do estoque pelo worker (o único processo que chama o Omie).
 *
 * Uma leitura percorre todas as páginas de ListarPosEstoque de uma empresa e só vira a posição
 * exibida quando o banco confere páginas e total (stock_worker_finish). Cada passo respeita um
 * orçamento de tempo e grava página a página; falhas temporárias (limite do Omie, rede) voltam
 * para a fila e continuam da última página; credencial recusada ou dado inválido encerram a
 * leitura sem mexer na posição publicada. Mensagens nunca carregam credenciais.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { acquireWorkerLease } from "@/lib/jobs/worker-lease.server";
import type { StockSchedule } from "@/lib/jobs/worker-core";
import { loadOmieCredentials } from "./credentials.server";
import { OmieClient, OmieError, redact, type OmieCredentials, type OmiePage } from "./omie-client";
import {
  LOCATIONS_CALL,
  LOCATIONS_LIST_KEYS,
  LOCATIONS_PATH,
  MAX_LOCATION_PAGES,
  STOCK_CALL,
  STOCK_LIST_KEYS,
  STOCK_PATH,
  StockRecordError,
  locationsPageParams,
  stockPageParams,
  toLocationEntry,
  toStockRow,
  type StockLocation,
} from "./stock-adapter";

type Admin = SupabaseClient<Database>;
// Funções da migração 0041, ainda fora dos tipos gerados.
type Rpc = (
  name: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface StockPageReader {
  listPage<T>(
    path: string,
    call: string,
    params: Record<string, unknown>,
    listKeys: string[],
  ): Promise<OmiePage<T>>;
}

export interface StockStepDeps {
  rpc: Rpc;
  acquireLease(key: string): Promise<(() => Promise<void>) | null>;
  loadCredentials(company: string): Promise<OmieCredentials>;
  client(credentials: OmieCredentials): StockPageReader;
  now(): number;
  log(event: Record<string, unknown>): void;
}

export interface StockStepResult {
  jobId: string | null;
  status?: string;
  done?: boolean;
}

interface Claim {
  id: string;
  companyId: string;
  positionDate: string;
  nextPage: number;
  locationsLoaded: boolean;
}

const rpcOf = (admin: Admin): Rpc => {
  const db = admin as unknown as { rpc: Rpc };
  return (name, args) => db.rpc(name, args);
};

const SLOT = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Configuração da leitura; null quando indisponível (migração ausente ou falha): nada roda. */
export async function readStockSchedule(admin: Admin): Promise<StockSchedule | null> {
  const { data, error } = await rpcOf(admin)("stock_worker_settings");
  if (error || !data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const slots = Array.isArray(value["slots"])
    ? (value["slots"] as unknown[]).filter(
        (s): s is string => typeof s === "string" && SLOT.test(s),
      )
    : [];
  const closeSlot = typeof value["closeSlot"] === "string" ? value["closeSlot"] : "";
  if (!SLOT.test(closeSlot)) return null;
  return { readingEnabled: value["readingEnabled"] === true, slots, closeSlot };
}

export async function enqueueStockReadings(
  admin: Admin,
  slot: string,
  kind: "intraday" | "close",
  day: string,
): Promise<number> {
  const { data, error } = await rpcOf(admin)("stock_worker_enqueue", {
    p_slot: slot,
    p_kind: kind,
    p_position_date: day,
  });
  if (error) throw new Error("Falha ao agendar a leitura do estoque.");
  return typeof data === "number" ? data : Number(data) || 0;
}

export function stockStepDeps(admin: Admin, log: StockStepDeps["log"]): StockStepDeps {
  return {
    rpc: rpcOf(admin),
    acquireLease: (key) => acquireWorkerLease(admin, key, 600),
    loadCredentials: (company) => loadOmieCredentials(admin, company),
    client: (credentials) =>
      new OmieClient(credentials, { maxRetries: 1, timeoutMs: 25_000, maxElapsedMs: 40_000 }),
    now: () => Date.now(),
    log,
  };
}

function parseClaim(data: unknown): Claim {
  const v = (data ?? {}) as Record<string, unknown>;
  const claim = {
    id: String(v["id"] ?? ""),
    companyId: String(v["companyId"] ?? ""),
    positionDate: String(v["positionDate"] ?? ""),
    nextPage: Number(v["nextPage"]),
    locationsLoaded: v["locationsLoaded"] === true,
  };
  if (!claim.id || !claim.companyId || !Number.isInteger(claim.nextPage) || claim.nextPage < 1)
    throw new Error("Pedido de leitura do estoque inválido.");
  return claim;
}

async function must<T>(rpc: Rpc, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(`Falha ao gravar a leitura do estoque (${name}).`);
  return data as T;
}

/** Nomes dos locais: ajudam a ler a tela, mas não impedem a leitura (o código basta). */
async function readLocations(reader: StockPageReader): Promise<Record<string, StockLocation>> {
  const out: Record<string, StockLocation> = {};
  try {
    for (let page = 1; page <= MAX_LOCATION_PAGES; page++) {
      const result = await reader.listPage<Record<string, unknown>>(
        LOCATIONS_PATH,
        LOCATIONS_CALL,
        locationsPageParams(page),
        LOCATIONS_LIST_KEYS,
      );
      for (const record of result.records) {
        const entry = toLocationEntry(record);
        if (entry) out[entry[0]] = entry[1];
      }
      if (page >= result.totalPages) break;
    }
  } catch (error) {
    if (error instanceof OmieError && ["rate_limit", "auth", "blocked"].includes(error.kind))
      throw error;
    return {};
  }
  return out;
}

/** Limite do Omie: espera o que ele pediu ou, sem indicação, 30 minutos (bloqueio 425). */
function retryAfterSeconds(error: unknown): number {
  if (error instanceof OmieError) {
    if (error.retryAfterMs > 0) return Math.ceil(error.retryAfterMs / 1000);
    if (error.kind === "rate_limit" || error.kind === "blocked") return 1800;
  }
  return 300;
}

function isFinal(error: unknown): boolean {
  if (error instanceof StockRecordError) return true;
  return error instanceof OmieError && (error.kind === "auth" || error.kind === "client");
}

function safeMessage(error: unknown, credentials?: OmieCredentials): string {
  if (error instanceof OmieError || error instanceof StockRecordError)
    return redact(error.message, credentials).slice(0, 300);
  return "Falha inesperada na leitura do estoque.";
}

/**
 * Um passo de leitura: pega a próxima leitura da fila e avança página a página até o
 * orçamento acabar. Nunca lança por falha do Omie; registra e devolve o estado.
 */
export async function runStockStep(
  deps: StockStepDeps,
  budgetMs = 15_000,
): Promise<StockStepResult> {
  const { data, error } = await deps.rpc("stock_worker_claim");
  if (error) throw new Error("Falha ao consultar a fila de leituras do estoque.");
  if (!data) return { jobId: null };
  const claim = parseClaim(data);
  const release = await deps.acquireLease(`omie:${claim.companyId}:stock`);
  if (!release) return { jobId: claim.id, status: "BUSY", done: false };
  const started = deps.now();
  let credentials: OmieCredentials | undefined;
  try {
    credentials = await deps.loadCredentials(claim.companyId);
    const reader = deps.client(credentials);
    if (!claim.locationsLoaded) {
      const locations = await readLocations(reader);
      await must(deps.rpc, "stock_worker_save_locations", {
        p_reading: claim.id,
        p_locations: locations,
      });
    }
    for (let page = claim.nextPage; ; page++) {
      const result = await reader.listPage<Record<string, unknown>>(
        STOCK_PATH,
        STOCK_CALL,
        stockPageParams(page, claim.positionDate),
        STOCK_LIST_KEYS,
      );
      const rows = result.records.map(toStockRow);
      const declared = result.totalRecords ?? (result.totalPages <= 1 ? rows.length : null);
      if (declared === null)
        throw new OmieError("incomplete", "O Omie não informou o total de posições.", true);
      const saved = await must<{ restarted?: boolean; done?: boolean }>(
        deps.rpc,
        "stock_worker_save_page",
        {
          p_reading: claim.id,
          p_page: page,
          p_pages_total: Math.max(1, result.totalPages),
          p_records_total: declared,
          p_rows: rows,
        },
      );
      if (saved?.restarted) {
        deps.log({ event: "stock_restarted", reading: claim.id, page });
        return { jobId: claim.id, status: "RESTARTED", done: false };
      }
      if (saved?.done) {
        const finished = await must<{ published?: boolean; positions?: number }>(
          deps.rpc,
          "stock_worker_finish",
          { p_reading: claim.id },
        );
        deps.log({
          event: finished?.published ? "stock_published" : "stock_restarted",
          reading: claim.id,
          positions: finished?.positions ?? null,
        });
        return {
          jobId: claim.id,
          status: finished?.published ? "SUCCESS" : "RESTARTED",
          done: finished?.published === true,
        };
      }
      if (deps.now() - started >= budgetMs)
        return { jobId: claim.id, status: "RUNNING", done: false };
    }
  } catch (failure) {
    const final = isFinal(failure);
    const message = safeMessage(failure, credentials);
    const { error: failError } = await deps.rpc("stock_worker_fail", {
      p_reading: claim.id,
      p_error: message,
      p_retry_after_seconds: retryAfterSeconds(failure),
      p_final: final,
    });
    deps.log({ event: "stock_failed", reading: claim.id, final, message, recorded: !failError });
    return { jobId: claim.id, status: final ? "FAILED" : "RETRY", done: final };
  } finally {
    await release();
  }
}
