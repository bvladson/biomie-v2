import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { OmieClient, OmieError, redact, type OmieCredentials } from "./omie-client";
import {
  TX_ADAPTERS,
  monthPartitions,
  type OmieTxEntity,
  type Period,
  type TxCanonical,
} from "./adapters";
import { promoteGoldIfAllowed } from "./sync.server";
import { acquireWorkerLease } from "@/lib/jobs/worker-lease.server";
import { emptyTxCheckpoint, parseTxCheckpoint, partitionProven } from "./checkpoint";
import { classifyCanonicalHeader, loadLegacyClassificationConfig } from "./classification.server";
import { loadOmieCredentials } from "./credentials.server";

type Admin = SupabaseClient<Database>;
// Generated types don't know dynamic table names; the tables are fixed below.
type Loose = { from: (t: string) => any; rpc: (f: string, a?: unknown) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Cadastros must exist before facts (dimensions first). */
const REQUIRES: Record<OmieTxEntity, string[]> = {
  invoices: ["vendors", "customers", "products"],
  orders: ["vendors", "customers", "products"],
  receivables: ["customers", "invoices"],
  settlements: ["receivables"],
};

const loadCredentials = (admin: Admin, company: string): Promise<OmieCredentials> =>
  loadOmieCredentials(admin, company);

/** Writes canonical header + items idempotently (unique keys in SQL). */
export async function upsertTxCanonical(
  admin: Admin,
  entity: OmieTxEntity,
  company: string,
  runId: string,
  rows: {
    external_id: string;
    raw_id: string;
    source_updated_at: string | null;
    c: TxCanonical;
    raw?: Record<string, unknown>;
  }[],
) {
  if (!rows.length) return;
  const db = admin as unknown as Loose;
  const now = new Date().toISOString();
  const classificationConfig =
    entity === "settlements" ? {} : await loadLegacyClassificationConfig(admin, company);
  const table = entity === "settlements" ? "canonical_settlements" : `canonical_${entity}`;
  const headers = rows.map((r) => ({
    company_id: company,
    source: "omie",
    external_id: r.external_id,
    sync_run_id: runId,
    canonicalized_at: now,
    ...(entity === "settlements"
      ? {}
      : {
          raw_record_id: r.raw_id,
          last_seen_run_id: runId,
          missing_in_source: false,
          source_updated_at: r.source_updated_at,
        }),
    ...classifyCanonicalHeader(
      entity,
      r.external_id,
      r.raw ?? {},
      r.c.header,
      classificationConfig,
    ),
  }));
  const { error } = await db
    .from(table)
    .upsert(headers, { onConflict: "company_id,source,external_id" });
  if (error) throw new Error(`Falha ao gravar Canonical: ${error.message}`);
  if (entity !== "invoices" && entity !== "orders") return;
  // Replace only the documents in this page, atomically. Plain UPSERT retained
  // removed source items forever, and an empty source list must remove old items.
  const { error: e2 } = await db.rpc("replace_omie_canonical_items", {
    p_company: company,
    p_entity: entity,
    p_run: runId,
    p_rows: rows.map((r) => ({ external_id: r.external_id, items: r.c.items ?? [] })),
  });
  if (e2) throw new Error(`Falha ao gravar itens: ${e2.message}`);
}

export interface TxStepResult {
  runId: string;
  done: boolean;
  status: "RUNNING" | "SUCCESS" | "WARNING" | "FAILED";
  received: number;
  message: string | null;
  retryable?: boolean;
  retryAfterMs?: number;
}

/**
 * One time-boxed step of a period sync for a transactional entity.
 * Period is split into month partitions; checkpoint = { partition, page }.
 */
export async function runTxSyncStep(
  admin: Admin,
  input: {
    company: string;
    entity: OmieTxEntity;
    period: Period;
    runId?: string;
    userId: string | null;
    backfillJobId?: string;
    budgetMs?: number;
  },
): Promise<TxStepResult> {
  const release = await acquireWorkerLease(admin, `omie:${input.company}:${input.entity}`);
  if (!release) throw new OmieError("blocked", "Esta entidade já está sendo processada.", true);
  try {
    return await runTxSyncStepUnlocked(admin, input);
  } finally {
    await release();
  }
}

async function runTxSyncStepUnlocked(
  admin: Admin,
  input: {
    company: string;
    entity: OmieTxEntity;
    period: Period;
    runId?: string;
    userId: string | null;
    backfillJobId?: string;
    budgetMs?: number;
  },
): Promise<TxStepResult> {
  const budget = input.budgetMs ?? 20_000;
  const t0 = Date.now();
  const adapter = TX_ADAPTERS[input.entity];
  const parts = monthPartitions(input.period);
  type Run = Database["public"]["Tables"]["integration_sync_runs"]["Row"];
  let run: Run;

  if (input.runId) {
    const { data } = await admin
      .from("integration_sync_runs")
      .select("*")
      .eq("id", input.runId)
      .single();
    if (!data || data.company_id !== input.company || data.entity !== input.entity)
      throw new Error("Execução não encontrada.");
    if (data.period_from !== input.period.from || data.period_to !== input.period.to)
      throw new Error("O período não corresponde ao checkpoint desta execução.");
    if (data.status === "SUCCESS" || data.status === "WARNING")
      throw new Error("Execução já concluída.");
    run = data;
    if (run.status !== "RUNNING") {
      const { error } = await admin
        .from("integration_sync_runs")
        .update({ status: "RUNNING", finished_at: null })
        .eq("id", run.id);
      if (error) throw new Error("Não foi possível retomar o checkpoint da execução.");
    }
  } else {
    for (const dep of REQUIRES[input.entity]) {
      const { count } = await admin
        .from("integration_sync_runs")
        .select("id", { count: "exact", head: true })
        .eq("company_id", input.company)
        .eq("entity", dep)
        .in("status", ["SUCCESS", "WARNING"]);
      if (!count) throw new Error(`Sincronize "${dep}" antes desta entidade.`);
    }
    const { data, error } = await admin
      .from("integration_sync_runs")
      .insert({
        company_id: input.company,
        entity: input.entity,
        mode: input.backfillJobId ? "BACKFILL" : "PERIOD",
        status: "RUNNING",
        period_from: input.period.from,
        period_to: input.period.to,
        checkpoint_start: { partition: 0, page: 1 },
        checkpoint_end: { partition: 0, page: 1 },
        triggered_by: input.userId,
        backfill_job_id: input.backfillJobId ?? null,
      })
      .select("*")
      .single();
    // The unique "one RUNNING per company+entity" index is the concurrency lock
    // (23505). Any other code is a real failure and must not be disguised as it.
    if (error || !data)
      throw new Error(
        error?.code === "23505"
          ? "Já existe uma sincronização em andamento para esta entidade."
          : `Não foi possível registrar a execução (código ${error?.code ?? "desconhecido"}).`,
      );
    run = data;
  }

  // Old checkpoints did not retain monthly record counts. Replay the entire
  // period idempotently rather than claiming completeness from missing proof.
  let cp = parseTxCheckpoint(run.checkpoint_end) ?? emptyTxCheckpoint();
  const reset = !parseTxCheckpoint(run.checkpoint_end);
  let partIdx = cp.partition;
  let page = cp.page;
  const proven: boolean[] = [...cp.proven];
  const c = {
    pages_done: reset ? 0 : run.pages_done,
    received: reset ? 0 : run.received,
    created: reset ? 0 : run.created,
    updated: reset ? 0 : run.updated,
    skipped: reset ? 0 : run.skipped,
    failed: reset ? 0 : run.failed,
  };
  let creds: OmieCredentials | undefined;

  const save = async (extra: Record<string, unknown> = {}, checkpoint = cp, counters = c) => {
    const { error } = await admin
      .from("integration_sync_runs")
      .update({
        ...counters,
        checkpoint_end: { ...checkpoint, heartbeat_at: new Date().toISOString() },
        ...extra,
      })
      .eq("id", run.id);
    if (error) throw new Error("Falha ao persistir o checkpoint transacional.");
  };

  try {
    creds = await loadCredentials(admin, input.company);
    const client = new OmieClient(creds);
    while (partIdx < parts.length && Date.now() - t0 < budget) {
      const next = { ...c };
      const nextCp = { ...cp, proven: [...proven], retryAttempts: 0, retryAt: "" };
      const period = parts[partIdx]!;
      const res = await client.listPage<Record<string, unknown>>(
        adapter.path,
        adapter.call,
        adapter.pageParams(page, adapter.pageSize, period),
        adapter.listKeys,
      );
      if (page === 1) {
        nextCp.expected = res.totalRecords;
        nextCp.received = 0;
        nextCp.totalPages = res.totalPages;
      } else if (
        cp.totalPages !== res.totalPages ||
        (cp.expected !== null && res.totalRecords !== null && cp.expected !== res.totalRecords)
      ) {
        throw new OmieError(
          "incomplete",
          "A paginação mudou durante a carga. Reinicie o período para comprovar a cobertura.",
          false,
        );
      }
      if (res.records.length) {
        const raws = [];
        for (const p of res.records) {
          const r = adapter.toRaw(p);
          if (r) raws.push({ ...r, method: adapter.call, page, requested_period: period });
          else next.failed++;
        }
        const { data: ing, error } = await admin.rpc("ingest_omie_raw", {
          p_entity: input.entity,
          p_company: input.company,
          p_run: run.id,
          p_rows:
            raws as unknown as Database["public"]["Functions"]["ingest_omie_raw"]["Args"]["p_rows"],
        });
        if (error || !ing) throw new Error(`Falha ao gravar RAW (página ${page}).`);
        const ingest = ing as {
          created: number;
          updated: number;
          skipped: number;
          ids: Record<string, string>;
        };
        next.created += ingest.created;
        next.updated += ingest.updated;
        next.skipped += ingest.skipped;
        next.received += res.records.length;
        nextCp.received += res.records.length;
        const canon = [];
        for (const r of raws) {
          const cc = adapter.toCanonical(r.payload);
          if (!ingest.ids[r.external_id])
            throw new Error("RAW não retornou o identificador persistido do registro.");
          if (cc)
            canon.push({
              external_id: r.external_id,
              raw_id: ingest.ids[r.external_id]!,
              source_updated_at: r.source_updated_at,
              c: cc,
              raw: r.payload,
            });
          else next.failed++;
        }
        await upsertTxCanonical(admin, input.entity, input.company, run.id, canon);
        const { error: markError } = await admin.rpc("mark_raw_processed", {
          p_entity: input.entity,
          p_company: input.company,
          p_ids: canon.map((x) => x.raw_id),
          p_state: "CANONICAL",
        });
        if (markError) throw new Error("Falha ao marcar os registros RAW processados.");
      }
      next.pages_done++;
      const lastPage = res.records.length === 0 || page >= res.totalPages;
      if (lastPage) {
        nextCp.proven[partIdx] = partitionProven(nextCp, page, res.totalPages);
        nextCp.partition = partIdx + 1;
        nextCp.page = 1;
        nextCp.expected = null;
        nextCp.received = 0;
        nextCp.totalPages = null;
      } else nextCp.page = page + 1;
      await save({}, nextCp, next);
      Object.assign(c, next);
      cp = nextCp;
      partIdx = cp.partition;
      page = cp.page;
      proven.splice(0, proven.length, ...cp.proven);
    }

    if (partIdx < parts.length) {
      return {
        runId: run.id,
        done: false,
        status: "RUNNING",
        received: c.received,
        message: `Mês ${partIdx + 1} de ${parts.length}.`,
      };
    }
    const warnings: string[] = [];
    const rawComplete = parts.every((_, i) => proven[i]);
    if (!rawComplete) warnings.push("Paginação não comprovou todos os registros em algum mês.");
    if (c.failed)
      warnings.push(`${c.failed} registro(s) sem campos obrigatórios foram ignorados (ver RAW).`);
    const canonicalComplete = rawComplete && c.failed === 0;
    const gold = canonicalComplete
      ? await promoteGoldIfAllowed(
          admin,
          input.company,
          input.entity === "settlements" ? "receivables" : input.entity,
        )
      : { ok: false, error: "Gold não promovido: carga RAW/Canonical incompleta." };
    if (gold.error) warnings.push(gold.error);
    const finishedAt = new Date();
    await save({
      status: warnings.length ? "WARNING" : "SUCCESS",
      message: warnings.join(" ") || null,
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - new Date(run.started_at).getTime(),
      raw_complete: rawComplete,
      canonical_complete: canonicalComplete,
      gold_complete: gold.ok,
    });
    return {
      runId: run.id,
      done: true,
      status: warnings.length ? "WARNING" : "SUCCESS",
      received: c.received,
      message: warnings.join(" ") || null,
    };
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : "Falha inesperada.", creds);
    console.error(
      `omie tx sync failed company=${input.company} entity=${input.entity} partition=${partIdx} page=${page}: ${msg}`,
    );
    const retryAttempts = (cp.retryAttempts ?? 0) + 1;
    const retryable =
      e instanceof OmieError && (e.retriable || e.kind === "blocked") && retryAttempts <= 8;
    const retryAfterMs =
      e instanceof OmieError && e.kind === "blocked"
        ? 300_000
        : Math.min(300_000, 30_000 * 2 ** (retryAttempts - 1));
    cp = {
      ...cp,
      retryAttempts,
      retryAt: retryable ? new Date(Date.now() + retryAfterMs).toISOString() : "",
    };
    await save({
      status: "FAILED",
      message: `Falha no mês ${partIdx + 1}, página ${page}: ${msg}`,
      error_page: page,
      finished_at: new Date().toISOString(),
    });
    return {
      runId: run.id,
      done: true,
      status: "FAILED",
      received: c.received,
      message: msg,
      retryable,
      retryAfterMs,
    };
  }
}

/** Advances the highest-priority pending backfill job by one step (worker/scheduler entrypoint). */
export async function runBackfillTick(
  admin: Admin,
): Promise<{ jobId: string | null; result: TxStepResult | null }> {
  const release = await acquireWorkerLease(admin, "omie:backfill");
  if (!release) return { jobId: null, result: null };
  try {
    return await runBackfillTickUnlocked(admin);
  } finally {
    await release();
  }
}

async function runBackfillTickUnlocked(
  admin: Admin,
): Promise<{ jobId: string | null; result: TxStepResult | null }> {
  const { data: jobs, error: jobsError } = await admin
    .from("integration_backfill_jobs")
    .select("*")
    .in("status", ["PENDING", "RUNNING"])
    // Dimension requests share the queue but are executed by the worker loop.
    .in("entity", Object.keys(TX_ADAPTERS))
    .order("priority")
    .order("created_at")
    .limit(20);
  if (jobsError) throw new Error("Falha ao consultar a fila de backfill.");
  for (const job of jobs ?? []) {
    const { data: latest, error: openError } = await admin
      .from("integration_sync_runs")
      .select("id,status,checkpoint_end")
      .eq("backfill_job_id", job.id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (openError) throw new Error("Falha ao consultar o checkpoint da fila.");
    // A process can die after the run commits SUCCESS but before the job update.
    // Recover that commit instead of creating a second run or getting stuck.
    if (latest && ["SUCCESS", "WARNING"].includes(latest.status)) {
      const { error } = await admin
        .from("integration_backfill_jobs")
        .update({
          status: "DONE",
          partitions_done: job.partitions_total,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .in("status", ["PENDING", "RUNNING"]);
      if (error) throw new Error("Falha ao recuperar a conclusão do backfill.");
      continue;
    }
    const checkpoint = parseTxCheckpoint(latest?.checkpoint_end);
    if (checkpoint?.retryAt && new Date(checkpoint.retryAt).getTime() > Date.now()) continue;
    const { data: claimed, error: claimError } = await admin
      .from("integration_backfill_jobs")
      .update({ status: "RUNNING", updated_at: new Date().toISOString() })
      .eq("id", job.id)
      .in("status", ["PENDING", "RUNNING"])
      .select("id")
      .maybeSingle();
    if (claimError) throw new Error("Falha ao reservar o backfill.");
    if (!claimed) continue; // Paused/cancelled concurrently by an administrator.
    if (!(job.entity in TX_ADAPTERS)) {
      await admin
        .from("integration_backfill_jobs")
        .update({ status: "FAILED", last_error: "Entidade transacional inválida." })
        .eq("id", job.id);
      continue;
    }
    let result: TxStepResult;
    try {
      result = await runTxSyncStep(admin, {
        company: job.company_id,
        entity: job.entity as OmieTxEntity,
        period: { from: job.period_from, to: job.period_to },
        userId: job.created_by,
        backfillJobId: job.id,
        ...(latest ? { runId: latest.id } : {}),
      });
    } catch (e) {
      // Lock contention is temporary and must not discard the queued job.
      if (e instanceof OmieError && e.retriable) continue;
      const { error } = await admin
        .from("integration_backfill_jobs")
        .update({
          status: "FAILED",
          last_error:
            "Não foi possível iniciar o passo. Verifique as dependências e o histórico da execução.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .in("status", ["PENDING", "RUNNING"]);
      if (error) throw new Error("Falha ao registrar o erro de início do backfill.");
      throw e;
    }
    const { data: runRow, error: checkpointError } = await admin
      .from("integration_sync_runs")
      .select("checkpoint_end")
      .eq("id", result.runId)
      .single();
    if (checkpointError) throw new Error("Falha ao consultar o progresso persistido do backfill.");
    const done = Number((runRow?.checkpoint_end as { partition?: number } | null)?.partition ?? 0);
    const { error: updateError } = await admin
      .from("integration_backfill_jobs")
      .update({
        status:
          result.status === "FAILED"
            ? result.retryable
              ? "RUNNING"
              : "FAILED"
            : result.done
              ? "DONE"
              : "RUNNING",
        partitions_done: Math.min(done, job.partitions_total),
        last_error: result.status === "FAILED" ? result.message : null,
        attempts: job.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .in("status", ["PENDING", "RUNNING"]);
    if (updateError) throw new Error("Falha ao registrar o progresso do backfill.");
    return { jobId: job.id, result };
  }
  return { jobId: null, result: null };
}
