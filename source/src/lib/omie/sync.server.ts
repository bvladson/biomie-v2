import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { acquireWorkerLease } from "@/lib/jobs/worker-lease.server";
import { OmieClient, OmieError, redact, type OmieCredentials } from "./omie-client";
import { loadOmieCredentials } from "./credentials.server";
import {
  ADAPTERS,
  ENTITY_ORDER,
  maskDocument,
  type CanonicalCustomer,
  type CanonicalProduct,
  type CanonicalVendor,
  type OmieEntity,
} from "./adapters";

type Admin = SupabaseClient<Database>;

/** Service-role only. Credentials are decrypted here and never leave this module. */
const loadCredentials = (admin: Admin, company: string): Promise<OmieCredentials> =>
  loadOmieCredentials(admin, company);

export type IntegrationStatus = "CONNECTED" | "ERROR" | "INVALID_CREDENTIALS";

export interface ConnectionResult {
  ok: boolean;
  status: IntegrationStatus;
  message: string;
  testedAt: string;
}

/** CONNECTED means an accepted Omie call, never just a stored credential. */
export async function testOmieConnection(admin: Admin, company: string): Promise<ConnectionResult> {
  const testedAt = new Date().toISOString();
  let result: ConnectionResult;
  let creds: OmieCredentials | undefined;
  try {
    creds = await loadCredentials(admin, company);
    const client = new OmieClient(creds, { maxRetries: 0, timeoutMs: 20_000 });
    const a = ADAPTERS.vendors;
    const page = await client.listPage(a.path, a.call, a.pageParams(1, 1), a.listKeys);
    result = {
      ok: true,
      status: "CONNECTED",
      message: `Conexão estabelecida. ${page.totalRecords ?? page.records.length} vendedor(es) visível(is) na conta.`,
      testedAt,
    };
  } catch (e) {
    const msg = e instanceof OmieError ? e.message : "Falha inesperada ao testar a conexão.";
    result = {
      ok: false,
      status: e instanceof OmieError && e.kind === "auth" ? "INVALID_CREDENTIALS" : "ERROR",
      message: redact(msg, creds),
      testedAt,
    };
  }
  const { error } = await admin.rpc(
    "record_integration_test" as never,
    {
      p_company: company,
      p_provider: "omie",
      p_status: result.status,
      p_ok: result.ok,
      p_message: result.message,
    } as never,
  );
  if (error) throw new Error("Não foi possível registrar o resultado do teste de conexão.");
  return result;
}

export interface SyncStepResult {
  runId: string;
  done: boolean;
  status: "RUNNING" | "SUCCESS" | "WARNING" | "FAILED";
  pagesDone: number;
  pagesTotal: number | null;
  received: number;
  message: string | null;
  retryable?: boolean;
  retryAfterMs?: number;
}

/** Gold promotion only for real companies outside DEMO; DEMO stays untouched. */
export async function promoteGoldIfAllowed(admin: Admin, company: string, entity: string) {
  const { data: c, error: companyError } = await admin
    .from("companies")
    .select("is_demo,data_source")
    .eq("id", company)
    .single();
  if (companyError) throw new Error("Falha ao verificar a empresa antes da promoção Gold.");
  if (!c || c.is_demo || c.data_source === "DEMO")
    return { ok: false, error: null as string | null };
  const { error } = await admin.rpc("promote_omie_gold", { p_company: company, p_entity: entity });
  if (error) return { ok: false, error: `Falha na promoção Gold: ${error.message}` };
  const { error: integrityError } = await admin.rpc("run_integrity_checks", { p_company: company });
  if (integrityError)
    return { ok: false, error: "Gold gravado, mas a verificação de integridade falhou." };
  return { ok: true, error: null as string | null };
}

/** Previous entity in ENTITY_ORDER must have a successful run first. */
async function assertOrder(admin: Admin, company: string, entity: OmieEntity) {
  const idx = ENTITY_ORDER.indexOf(entity);
  if (idx <= 0) return;
  const prev = ENTITY_ORDER[idx - 1]!;
  const { count } = await admin
    .from("integration_sync_runs")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company)
    .eq("entity", prev)
    .in("status", ["SUCCESS", "WARNING"]);
  if (!count)
    throw new Error(
      `Sincronize ${prev === "vendors" ? "Vendedores" : "Clientes"} antes desta entidade.`,
    );
}

async function upsertCanonical(
  admin: Admin,
  entity: OmieEntity,
  company: string,
  runId: string,
  rows: { external_id: string; raw_id: string; source_updated_at: string | null; c: unknown }[],
) {
  if (!rows.length) return;
  const base = (r: (typeof rows)[number]) => ({
    company_id: company,
    source: "omie",
    external_id: r.external_id,
    raw_record_id: r.raw_id,
    sync_run_id: runId,
    last_seen_run_id: runId,
    missing_in_source: false,
    source_updated_at: r.source_updated_at,
    canonicalized_at: new Date().toISOString(),
  });
  const onConflict = "company_id,source,external_id";
  let error: { message: string } | null = null;
  if (entity === "vendors") {
    ({ error } = await admin.from("canonical_vendors").upsert(
      rows.map((r) => ({ ...base(r), ...(r.c as CanonicalVendor) })),
      { onConflict },
    ));
  } else if (entity === "customers") {
    const { createHash } = await import("node:crypto");
    ({ error } = await admin.from("canonical_customers").upsert(
      rows.map((r) => {
        const { document_digits, ...c } = r.c as CanonicalCustomer;
        return {
          ...base(r),
          ...c,
          document_hash: document_digits
            ? createHash("sha256").update(document_digits).digest("hex")
            : null,
          document_masked: maskDocument(document_digits),
        };
      }),
      { onConflict },
    ));
  } else {
    ({ error } = await admin.from("canonical_products").upsert(
      rows.map((r) => ({ ...base(r), ...(r.c as CanonicalProduct) })),
      { onConflict },
    ));
  }
  if (error) throw new Error(`Falha ao gravar Canonical: ${error.message}`);
}

/**
 * Processes pages of a FULL sync until the time budget is used, saving a
 * checkpoint after each page. Call repeatedly with the returned runId until
 * done. A page that fails after retries marks the run FAILED (with the page)
 * and is never treated as complete; it can be resumed from the checkpoint.
 */
export async function runSyncStep(
  admin: Admin,
  input: {
    company: string;
    entity: OmieEntity;
    runId?: string;
    userId: string | null;
    budgetMs?: number;
  },
): Promise<SyncStepResult> {
  const release = await acquireWorkerLease(admin, `omie:${input.company}:${input.entity}`);
  if (!release)
    throw new OmieError(
      "blocked",
      "Esta entidade está sendo processada. Aguarde o próximo passo.",
      true,
    );
  try {
    return await runSyncStepUnlocked(admin, input);
  } finally {
    await release();
  }
}

async function runSyncStepUnlocked(
  admin: Admin,
  input: {
    company: string;
    entity: OmieEntity;
    runId?: string;
    userId: string | null;
    budgetMs?: number;
  },
): Promise<SyncStepResult> {
  const budget = input.budgetMs ?? 20_000;
  const t0 = Date.now();
  const adapter = ADAPTERS[input.entity];

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
    if (data.status === "SUCCESS" || data.status === "WARNING")
      throw new Error("Execução já concluída.");
    run = data;
    if (run.status !== "RUNNING") {
      const { error: resumeError } = await admin
        .from("integration_sync_runs")
        .update({ status: "RUNNING", message: "Retomada do checkpoint.", finished_at: null })
        .eq("id", run.id);
      if (resumeError) throw new Error("Não foi possível retomar a sincronização.");
    }
  } else {
    await assertOrder(admin, input.company, input.entity);
    const { data: running } = await admin
      .from("integration_sync_runs")
      .select("id")
      .eq("company_id", input.company)
      .eq("entity", input.entity)
      .eq("status", "RUNNING");
    if (running?.length)
      throw new Error("Já existe uma sincronização em andamento para esta entidade.");
    const { data, error } = await admin
      .from("integration_sync_runs")
      .insert({
        company_id: input.company,
        entity: input.entity,
        mode: "FULL",
        status: "RUNNING",
        checkpoint_start: { page: 1 },
        checkpoint_end: { page: 1 },
        triggered_by: input.userId,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error("Não foi possível registrar a sincronização.");
    run = data;
  }

  let creds: OmieCredentials | undefined;
  const counters = {
    pages_done: run.pages_done,
    received: run.received,
    created: run.created,
    updated: run.updated,
    skipped: run.skipped,
    failed: run.failed,
  };
  let page = Number((run.checkpoint_end as { page?: number } | null)?.page ?? 1);
  let retryAttempts = Number(
    (run.checkpoint_end as { retryAttempts?: number } | null)?.retryAttempts ?? 0,
  );
  let retryAt = "";
  let totalPages = run.pages_total;
  let expected = run.expected_records;
  const warnings: string[] = [];

  const finish = async (
    status: "SUCCESS" | "WARNING" | "FAILED",
    message: string | null,
    errorPage?: number,
  ) => {
    const finishedAt = new Date();
    const { error: finishError } = await admin
      .from("integration_sync_runs")
      .update({
        ...counters,
        pages_total: totalPages,
        expected_records: expected,
        status,
        message,
        error_page: errorPage ?? null,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - new Date(run.started_at).getTime(),
        checkpoint_end: { page, retryAttempts, retryAt },
      })
      .eq("id", run.id);
    if (finishError) throw new Error("Não foi possível persistir o estado final da sincronização.");
    return {
      runId: run.id,
      done: true,
      status,
      pagesDone: counters.pages_done,
      pagesTotal: totalPages,
      received: counters.received,
      message,
    } satisfies SyncStepResult;
  };

  try {
    creds = await loadCredentials(admin, input.company);
    const client = new OmieClient(creds);
    while (Date.now() - t0 < budget) {
      const nextCounters = { ...counters };
      const res = await client.listPage<Record<string, unknown>>(
        adapter.path,
        adapter.call,
        adapter.pageParams(page, adapter.pageSize),
        adapter.listKeys,
      );
      if (
        page > 1 &&
        res.records.length &&
        ((totalPages !== null && totalPages !== res.totalPages) ||
          (expected !== null && res.totalRecords !== null && expected !== res.totalRecords))
      )
        throw new OmieError(
          "incomplete",
          "A paginação mudou durante a carga. Reinicie a carga completa para comprovar a cobertura.",
          false,
        );
      if (res.records.length || page === 1) totalPages = res.totalPages;
      if (page === 1 && res.totalRecords !== null) expected = res.totalRecords;
      if (res.records.length) {
        const raws = [];
        for (const p of res.records) {
          const r = adapter.toRaw(p);
          if (r) raws.push(r);
          else nextCounters.failed++;
        }
        const { data: ing, error } = await admin.rpc("ingest_omie_raw", {
          p_entity: input.entity,
          p_company: input.company,
          p_run: run.id,
          p_rows: raws.map((r) => ({
            ...r,
            method: adapter.call,
            page,
          })) as unknown as Database["public"]["Functions"]["ingest_omie_raw"]["Args"]["p_rows"],
        });
        if (error || !ing) throw new Error(`Falha ao gravar RAW (página ${page}).`);
        const ingest = ing as {
          created: number;
          updated: number;
          skipped: number;
          ids: Record<string, string>;
        };
        nextCounters.created += ingest.created;
        nextCounters.updated += ingest.updated;
        nextCounters.skipped += ingest.skipped;
        nextCounters.received += res.records.length;
        const rawIds = Object.values(ingest.ids);
        if (raws.some((r) => !ingest.ids[r.external_id]))
          throw new Error("RAW não retornou o identificador persistido do registro.");
        await upsertCanonical(
          admin,
          input.entity,
          input.company,
          run.id,
          raws.map((r) => ({
            external_id: r.external_id,
            raw_id: ingest.ids[r.external_id]!,
            source_updated_at: r.source_updated_at,
            c: adapter.toCanonical(r.payload),
          })),
        );
        const { error: markError } = await admin.rpc("mark_raw_processed", {
          p_entity: input.entity,
          p_company: input.company,
          p_ids: rawIds,
          p_state: "CANONICAL",
        });
        if (markError) throw new Error("Falha ao marcar os registros RAW processados.");
      }
      nextCounters.pages_done++;
      const last = res.records.length === 0 || page >= res.totalPages;
      const { error: checkpointError } = await admin
        .from("integration_sync_runs")
        .update({
          ...nextCounters,
          pages_total: totalPages,
          expected_records: expected,
          checkpoint_end: { page: page + 1, heartbeat_at: new Date().toISOString() },
        })
        .eq("id", run.id);
      if (checkpointError)
        throw new Error("Falha ao salvar o checkpoint; a página será reprocessada com segurança.");
      Object.assign(counters, nextCounters);
      retryAttempts = 0;
      page++;
      if (last) {
        // RAW_COMPLETE is proven by pagination metadata, not by an empty page alone.
        const rawComplete =
          totalPages !== null &&
          counters.pages_done >= totalPages &&
          (expected === null || counters.received === expected);
        if (!rawComplete)
          warnings.push(
            `Paginação inconsistente: ${counters.received} de ${expected ?? "?"} registros em ${counters.pages_done}/${totalPages ?? "?"} páginas.`,
          );
        const canonicalComplete = rawComplete && counters.failed === 0;
        const missing = canonicalComplete
          ? await admin.rpc("finish_omie_full_sync", {
              p_entity: input.entity,
              p_company: input.company,
              p_run: run.id,
            })
          : { data: null, error: null };
        if (missing.error)
          throw new Error("Falha ao finalizar a presença dos registros da carga completa.");
        // Presence flags must be finalized before promoting active dimensions.
        const gold = canonicalComplete
          ? await promoteGoldIfAllowed(admin, input.company, input.entity)
          : { ok: false, error: "Gold não promovido: carga RAW/Canonical incompleta." };
        if (gold.error) warnings.push(gold.error);
        const { error: proofError } = await admin
          .from("integration_sync_runs")
          .update({
            raw_complete: rawComplete,
            canonical_complete: canonicalComplete,
            gold_complete: gold.ok,
          })
          .eq("id", run.id);
        if (proofError) throw new Error("Falha ao salvar as provas de completude da carga.");
        if (typeof missing.data === "number" && missing.data > 0)
          warnings.push(
            `${missing.data} registro(s) não vieram nesta carga completa (marcados, não apagados).`,
          );
        if (counters.failed > 0)
          warnings.push(`${counters.failed} registro(s) sem identificador foram ignorados.`);
        // Matching runs with service role through the same SQL used by admins.
        const { error: matchesError } = await admin.rpc("compute_omie_matches", {
          p_company: input.company,
          p_entity: input.entity,
        });
        if (matchesError) {
          const code = /^[A-Z0-9]{3,12}$/.test(matchesError.code ?? "")
            ? matchesError.code
            : "UNKNOWN";
          warnings.push(`A conferência de vínculos não foi concluída (código ${code}).`);
          console.error(
            JSON.stringify({
              job: "omie_matching",
              company: input.company,
              entity: input.entity,
              code,
            }),
          );
        }
        return await finish(warnings.length ? "WARNING" : "SUCCESS", warnings.join(" ") || null);
      }
    }
    return {
      runId: run.id,
      done: false,
      status: "RUNNING",
      pagesDone: counters.pages_done,
      pagesTotal: totalPages,
      received: counters.received,
      message: null,
    };
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : "Falha inesperada.", creds);
    console.error(
      `omie sync failed company=${input.company} entity=${input.entity} page=${page}: ${msg}`,
    );
    retryAttempts++;
    const retryable =
      e instanceof OmieError && (e.retriable || e.kind === "blocked") && retryAttempts <= 8;
    const retryAfterMs =
      e instanceof OmieError && e.kind === "blocked"
        ? 300_000
        : Math.min(300_000, 30_000 * 2 ** (retryAttempts - 1));
    retryAt = retryable ? new Date(Date.now() + retryAfterMs).toISOString() : "";
    return {
      ...(await finish("FAILED", `Falha na página ${page}: ${msg}`, page)),
      retryable,
      retryAfterMs,
    };
  }
}
