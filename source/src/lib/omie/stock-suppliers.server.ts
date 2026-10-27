/**
 * Fornecedores do Omie pelo worker (migração 0048): ListarProdutoFornecedor página a página (10 cadastros
 * por página, o máximo documentado), SÓ LEITURA, com orçamento de tempo. Cada vínculo produto × fornecedor
 * é gravado pelo código do Omie, então repetir uma página não duplica nada. Falhas temporárias voltam para a
 * fila (nunca antes de 2 min: o Omie recusa a mesma consulta repetida em menos de 1 min); credencial
 * recusada encerra a importação. CPF/CNPJ não é lido. Mensagens nunca carregam credenciais.
 */
import { OmieError } from "./omie-client";
import {
  StockRecordError,
  SUPPLIERS_CALL,
  SUPPLIERS_LIST_KEYS,
  SUPPLIERS_PATH,
  suppliersPageParams,
  toSupplierRow,
} from "./stock-adapter";
import {
  failureDetail,
  safeStockMessage,
  type StockStepDeps,
  type StockStepResult,
} from "./stock.server";

interface SupplierClaim {
  id: string;
  companyId: string;
  nextPage: number;
}

function parseClaim(data: unknown): SupplierClaim {
  const v = (data ?? {}) as Record<string, unknown>;
  const claim = {
    id: String(v["id"] ?? ""),
    companyId: String(v["companyId"] ?? ""),
    nextPage: Number(v["nextPage"]),
  };
  if (!claim.id || !claim.companyId || !Number.isInteger(claim.nextPage) || claim.nextPage < 1)
    throw new Error("Pedido de importação de fornecedores inválido.");
  return claim;
}

function retryAfterSeconds(error: unknown): number {
  if (error instanceof OmieError) {
    if (error.retryAfterMs > 0) return Math.max(120, Math.ceil(error.retryAfterMs / 1000));
    if (error.kind === "rate_limit" || error.kind === "blocked") return 1800;
  }
  return 300;
}

const isFinal = (error: unknown) =>
  error instanceof StockRecordError ||
  (error instanceof OmieError && (error.kind === "auth" || error.kind === "client"));

export async function runStockSuppliersStep(
  deps: StockStepDeps,
  budgetMs = 15_000,
): Promise<StockStepResult> {
  const { data, error } = await deps.rpc("stock_worker_suppliers_claim");
  if (error) throw new Error("Falha ao consultar a fila de fornecedores do estoque.");
  if (!data) return { jobId: null };
  const claim = parseClaim(data);
  const release = await deps.acquireLease(`omie:${claim.companyId}:stock-suppliers`);
  if (!release) return { jobId: claim.id, status: "BUSY", done: false };
  const started = deps.now();
  let credentials: Awaited<ReturnType<StockStepDeps["loadCredentials"]>> | undefined;
  try {
    credentials = await deps.loadCredentials(claim.companyId);
    const reader = deps.client(credentials);
    for (let page = claim.nextPage; ; page++) {
      const result = await reader.listPage<Record<string, unknown>>(
        SUPPLIERS_PATH,
        SUPPLIERS_CALL,
        suppliersPageParams(page),
        SUPPLIERS_LIST_KEYS,
      );
      const rows = result.records.map(toSupplierRow).filter((r) => r !== null);
      const declared =
        result.totalRecords ?? (result.totalPages <= 1 ? result.records.length : null);
      if (declared === null)
        throw new OmieError("incomplete", "O Omie não informou o total de fornecedores.", true);
      const { data: saved, error: saveError } = await deps.rpc("stock_worker_suppliers_save_page", {
        p_job: claim.id,
        p_page: page,
        p_pages_total: Math.max(1, result.totalPages),
        p_records_total: declared,
        p_rows: rows,
        p_skipped: result.records.length - rows.length,
      });
      if (saveError) throw new Error("Falha ao gravar os fornecedores do estoque.");
      const s = (saved ?? {}) as { restarted?: boolean; done?: boolean };
      if (s.restarted) {
        deps.log({ event: "stock_suppliers_restarted", job: claim.id, page });
        return { jobId: claim.id, status: "RESTARTED", done: false };
      }
      if (s.done) {
        const { data: fin, error: finError } = await deps.rpc("stock_worker_suppliers_finish", {
          p_job: claim.id,
        });
        if (finError) throw new Error("Falha ao concluir a importação de fornecedores.");
        const f = (fin ?? {}) as { links?: number; linksRemoved?: number; keptPrevious?: boolean };
        deps.log({
          event: "stock_suppliers_done",
          job: claim.id,
          links: f.links ?? null,
          linksRemoved: f.linksRemoved ?? null,
          keptPrevious: f.keptPrevious === true,
        });
        return { jobId: claim.id, status: "SUCCESS", done: true };
      }
      if (deps.now() - started >= budgetMs)
        return { jobId: claim.id, status: "RUNNING", done: false };
    }
  } catch (failure) {
    const final = isFinal(failure);
    const message = safeStockMessage(failure, credentials);
    const { error: failError } = await deps.rpc("stock_worker_suppliers_fail", {
      p_job: claim.id,
      p_error: message,
      p_retry_after_seconds: retryAfterSeconds(failure),
      p_final: final,
    });
    deps.log({
      event: "stock_suppliers_failed",
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
