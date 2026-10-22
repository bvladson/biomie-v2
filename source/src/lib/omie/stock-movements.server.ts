/**
 * Movimentações do estoque pelo worker (migração 0043): ListarMovimentoEstoque em blocos de
 * período (carga inicial de até 12 meses e atualização dos últimos dias), página a página, com
 * orçamento de tempo. Cada movimento é gravado pelo identificador do Omie, então repetir uma
 * página não duplica nada. Falhas temporárias voltam para a fila; credencial recusada encerra o
 * bloco. Mensagens nunca carregam credenciais. Ao terminar o último bloco da empresa, recalcula
 * as curvas (última entrada e chegada do produto).
 */
import { OmieError } from "./omie-client";
import {
  MOVEMENTS_CALL,
  MOVEMENTS_LIST_KEYS,
  MOVEMENTS_PATH,
  StockRecordError,
  movementsPageParams,
  toMovementRow,
} from "./stock-adapter";
import {
  refreshCurves,
  safeStockMessage,
  failureDetail,
  type StockStepDeps,
  type StockStepResult,
} from "./stock.server";

interface MovementClaim {
  id: string;
  companyId: string;
  from: string;
  to: string;
  nextPage: number;
}

function parseClaim(data: unknown): MovementClaim {
  const v = (data ?? {}) as Record<string, unknown>;
  const claim = {
    id: String(v["id"] ?? ""),
    companyId: String(v["companyId"] ?? ""),
    from: String(v["from"] ?? ""),
    to: String(v["to"] ?? ""),
    nextPage: Number(v["nextPage"]),
  };
  if (!claim.id || !claim.companyId || !Number.isInteger(claim.nextPage) || claim.nextPage < 1)
    throw new Error("Pedido de leitura de movimentações inválido.");
  return claim;
}

function retryAfterSeconds(error: unknown): number {
  if (error instanceof OmieError) {
    if (error.retryAfterMs > 0) return Math.ceil(error.retryAfterMs / 1000);
    if (error.kind === "rate_limit" || error.kind === "blocked") return 1800;
  }
  return 300;
}

const isFinal = (error: unknown) =>
  error instanceof StockRecordError ||
  (error instanceof OmieError && (error.kind === "auth" || error.kind === "client"));

export async function runStockMovementsStep(
  deps: StockStepDeps,
  budgetMs = 15_000,
): Promise<StockStepResult> {
  const { data, error } = await deps.rpc("stock_worker_movements_claim");
  if (error) throw new Error("Falha ao consultar a fila de movimentações do estoque.");
  if (!data) return { jobId: null };
  const claim = parseClaim(data);
  const release = await deps.acquireLease(`omie:${claim.companyId}:stock-movements`);
  if (!release) return { jobId: claim.id, status: "BUSY", done: false };
  const started = deps.now();
  let credentials: Awaited<ReturnType<StockStepDeps["loadCredentials"]>> | undefined;
  try {
    credentials = await deps.loadCredentials(claim.companyId);
    const reader = deps.client(credentials);
    for (let page = claim.nextPage; ; page++) {
      const result = await reader.listPage<Record<string, unknown>>(
        MOVEMENTS_PATH,
        MOVEMENTS_CALL,
        movementsPageParams(page, claim.from, claim.to),
        MOVEMENTS_LIST_KEYS,
      );
      const rows = result.records.map(toMovementRow).filter((r) => r !== null);
      const declared =
        result.totalRecords ?? (result.totalPages <= 1 ? result.records.length : null);
      if (declared === null)
        throw new OmieError("incomplete", "O Omie não informou o total de movimentações.", true);
      const { data: saved, error: saveError } = await deps.rpc("stock_worker_movements_save_page", {
        p_job: claim.id,
        p_page: page,
        p_pages_total: Math.max(1, result.totalPages),
        p_records_total: declared,
        p_rows: rows,
        p_skipped: result.records.length - rows.length,
      });
      if (saveError) throw new Error("Falha ao gravar as movimentações do estoque.");
      const s = (saved ?? {}) as { restarted?: boolean; done?: boolean };
      if (s.restarted) {
        deps.log({ event: "stock_movements_restarted", job: claim.id, page });
        return { jobId: claim.id, status: "RESTARTED", done: false };
      }
      if (s.done) {
        const { data: fin, error: finError } = await deps.rpc("stock_worker_movements_finish", {
          p_job: claim.id,
        });
        if (finError) throw new Error("Falha ao concluir a leitura de movimentações.");
        const f = (fin ?? {}) as { records?: number; lastOfCompany?: boolean };
        deps.log({ event: "stock_movements_done", job: claim.id, records: f.records ?? null });
        if (f.lastOfCompany) await refreshCurves(deps, claim.companyId);
        return { jobId: claim.id, status: "SUCCESS", done: true };
      }
      if (deps.now() - started >= budgetMs)
        return { jobId: claim.id, status: "RUNNING", done: false };
    }
  } catch (failure) {
    const final = isFinal(failure);
    const message = safeStockMessage(failure, credentials);
    const { error: failError } = await deps.rpc("stock_worker_movements_fail", {
      p_job: claim.id,
      p_error: message,
      p_retry_after_seconds: retryAfterSeconds(failure),
      p_final: final,
    });
    deps.log({
      event: "stock_movements_failed",
      job: claim.id,
      final,
      message,
      detail: failureDetail(failure, credentials),
      recorded: !failError,
    });
    return { jobId: claim.id, status: final ? "FAILED" : "RETRY", done: final };
  } finally {
    await release();
  }
}
