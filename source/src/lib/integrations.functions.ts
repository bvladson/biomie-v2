import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const entitySchema = z.enum(["vendors", "customers", "products"]);
const companySchema = z.object({ company: z.string().uuid() });

async function assertAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data } = await supabase.rpc("is_admin", { _user_id: userId });
  if (!data) throw new Error("Acesso restrito a administradores.");
}

async function assertAdminCompany(
  supabase: SupabaseClient<Database>,
  userId: string,
  company: string,
) {
  await assertAdmin(supabase, userId);
  const { data, error } = await supabase.rpc("can_access_company", {
    _user_id: userId,
    _company: company,
  });
  if (error || !data) throw new Error("Sem acesso a esta empresa.");
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * In production every Omie load runs in the separate worker process, which owns
 * the shared rate limiter. The web process only enqueues the request.
 */
function inlineSyncAllowed() {
  return process.env["APP_ENV"] !== "production" || process.env["BIOMIE_ALLOW_WEB_SYNC"] === "1";
}

const QUEUED_MESSAGE =
  "Sincronização enviada para o worker. Acompanhe o andamento em Qualidade dos Dados / Integrações.";

async function enqueue(
  supabase: SupabaseClient<Database>,
  company: string,
  entity: string,
  period?: { from: string; to: string },
) {
  const { error } = await supabase.rpc("manage_backfill", {
    p_company: company,
    p_action: "create",
    p_entity: entity,
    ...(period ? { p_from: period.from, p_to: period.to } : {}),
    p_priority: 50,
  });
  if (error) throw new Error(error.message || "Não foi possível agendar a sincronização.");
}

export interface MigrationRow {
  entity: string;
  label: string;
  enabled: boolean;
  raw: number;
  canonical: number;
  missingInSource: number;
  gold: number;
  duplicates: number;
  matched: number;
  conflicts: number;
  unmatched: number;
  ignored: number;
  status: string;
  lastSuccessAt: string | null;
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    received: number;
    failed: number;
    message: string | null;
    durationMs: number | null;
    pagesDone: number;
    pagesTotal: number | null;
  } | null;
}

export const fetchIntegrationOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const [{ data: integ }, { data: company }, { data: migration, error }] = await Promise.all([
      context.supabase
        .from("company_integrations")
        .select("*")
        .eq("company_id", data.company)
        .eq("provider", "omie")
        .maybeSingle(),
      context.supabase
        .from("companies")
        .select("id,name,data_source")
        .eq("id", data.company)
        .single(),
      context.supabase.rpc("omie_migration_status", { p_company: data.company }),
    ]);
    if (error) throw new Error("Não foi possível carregar o status da migração.");
    return {
      integration: integ
        ? {
            status: integ.status,
            appKeyHint: integ.app_key_hint,
            environment: integ.environment,
            lastTestAt: integ.last_test_at,
            lastTestOk: integ.last_test_ok,
            lastTestMessage: integ.last_test_message,
            lastSuccessAt: integ.last_success_at,
          }
        : null,
      dataSource: (company as { data_source?: string } | null)?.data_source ?? "DEMO",
      migration: (migration ?? []) as unknown as MigrationRow[],
    };
  });

export const saveOmieCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    companySchema
      .extend({
        appKey: z.string().trim().min(4).max(200),
        appSecret: z.string().trim().min(4).max(200),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdminCompany(context.supabase, context.userId, data.company);
    // Encrypted here, server-side; the database only ever receives ciphertext.
    const { encryptOmieCredentials } = await import("./omie/credentials.server");
    const encrypted = encryptOmieCredentials(data.company, data.appKey, data.appSecret);
    const { error } = await context.supabase.rpc(
      "set_integration_credentials_encrypted" as never,
      {
        p_company: data.company,
        p_provider: "omie",
        p_app_key_enc: encrypted.appKeyEnc,
        p_app_secret_enc: encrypted.appSecretEnc,
        p_app_key_hint: encrypted.hint,
      } as never,
    );
    if (error) throw new Error("Não foi possível salvar as credenciais.");
    return { ok: true };
  });

export const testOmie = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdminCompany(context.supabase, context.userId, data.company);
    const { testOmieConnection } = await import("./omie/sync.server");
    return testOmieConnection(await admin(), data.company);
  });

export const syncOmieStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    companySchema.extend({ entity: entitySchema, runId: z.string().uuid().optional() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdminCompany(context.supabase, context.userId, data.company);
    if (!inlineSyncAllowed()) {
      await enqueue(context.supabase, data.company, data.entity);
      return {
        runId: "",
        done: true,
        status: "SUCCESS" as const,
        pagesDone: 0,
        pagesTotal: null,
        received: 0,
        message: QUEUED_MESSAGE,
      };
    }
    const { runSyncStep } = await import("./omie/sync.server");
    return runSyncStep(await admin(), {
      company: data.company,
      entity: data.entity,
      ...(data.runId ? { runId: data.runId } : {}),
      userId: context.userId,
    });
  });

export interface WorkerStatusDTO {
  paused: boolean;
  recurring: boolean;
  reason: string | null;
  state: string | null;
  heartbeatAt: string | null;
  lastJob: string | null;
}

export const fetchWorkerStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WorkerStatusDTO> => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("worker_status" as never);
    if (error) throw new Error("Não foi possível carregar o status do worker.");
    const value = (data ?? {}) as {
      control?: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    const text = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      paused: value.control?.["paused"] === true,
      recurring: value.control?.["recurring"] === true,
      reason: text(value.control?.["reason"]),
      state: text(value.status?.["state"]),
      heartbeatAt: text(value.status?.["heartbeat_at"]),
      lastJob: text(value.status?.["lastJob"]),
    };
  });

/** Pause/resume is restricted to SUPER_ADMIN inside set_worker_control. */
export const controlWorker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ action: z.enum(["pause", "resume"]) }).parse(i))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc(
      "set_worker_control" as never,
      {
        p_paused: data.action === "pause",
        p_reason: data.action === "pause" ? "pausa pela tela" : "retomada pela tela",
      } as never,
    );
    if (error) throw new Error(error.message || "Não foi possível alterar o worker.");
    return { ok: true };
  });

export const fetchOmieComparison = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.extend({ entity: entitySchema }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("omie_comparison", {
      p_company: data.company,
      p_entity: data.entity,
    });
    if (error) throw new Error("Não foi possível carregar a comparação.");
    return rows ?? [];
  });

export const resolveOmieMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        matchId: z.string().uuid(),
        biomieId: z.string().uuid().nullable(),
        ignore: z.boolean(),
        note: z.string().trim().min(3).max(500),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("resolve_omie_match", {
      p_match: data.matchId,
      p_biomie_id: data.biomieId as string,
      p_ignore: data.ignore,
      p_note: data.note,
    });
    if (error) throw new Error(error.message || "Não foi possível registrar a decisão.");
    return { ok: true };
  });

export const setDataSource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    companySchema
      .extend({ source: z.enum(["DEMO", "OMIE_SHADOW", "OMIE"]), confirmation: z.string().max(40) })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("set_company_data_source", {
      p_company: data.company,
      p_source: data.source,
      p_confirmation: data.confirmation,
    });
    if (error) throw new Error(error.message || "Troca de fonte não permitida.");
    return { ok: true };
  });

const txEntitySchema = z.enum(["invoices", "orders", "receivables", "settlements"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const syncOmieTxStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    companySchema
      .extend({
        entity: txEntitySchema,
        from: isoDate,
        to: isoDate,
        runId: z.string().uuid().optional(),
      })
      .refine((v) => v.to >= v.from, "Período inválido")
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdminCompany(context.supabase, context.userId, data.company);
    if (!inlineSyncAllowed()) {
      await enqueue(context.supabase, data.company, data.entity, { from: data.from, to: data.to });
      return {
        runId: "",
        done: true,
        status: "SUCCESS" as const,
        received: 0,
        message: QUEUED_MESSAGE,
      };
    }
    const { runTxSyncStep } = await import("./omie/sync-tx.server");
    return runTxSyncStep(await admin(), {
      company: data.company,
      entity: data.entity,
      period: { from: data.from, to: data.to },
      userId: context.userId,
      ...(data.runId ? { runId: data.runId } : {}),
    });
  });

export interface ReadinessRow {
  entity: string;
  state: string;
  lastRunAt: string | null;
  finishedAt: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  expected: number | null;
  received: number | null;
  failed: number | null;
  openIssues: number;
  stale: boolean;
  runStatus: string | null;
  message: string | null;
}

export interface BackfillJob {
  id: string;
  entity: string;
  period_from: string;
  period_to: string;
  status: string;
  partitions_total: number;
  partitions_done: number;
  last_error: string | null;
  priority: number;
  updated_at: string;
}

export interface IntegrityIssue {
  id: string;
  entity: string;
  external_id: string | null;
  check_key: string;
  severity: string;
  reason: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrences: number;
  status: string;
  justification: string | null;
}

export const fetchIntegrity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const [ready, jobs, issues, runs] = await Promise.all([
      context.supabase.rpc("omie_readiness", { p_company: data.company }),
      context.supabase
        .from("integration_backfill_jobs")
        .select(
          "id,entity,period_from,period_to,status,partitions_total,partitions_done,last_error,priority,updated_at",
        )
        .eq("company_id", data.company)
        .order("created_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("integrity_issues")
        .select(
          "id,entity,external_id,check_key,severity,reason,first_seen_at,last_seen_at,occurrences,status,justification",
        )
        .eq("company_id", data.company)
        .order("last_seen_at", { ascending: false })
        .limit(200),
      context.supabase
        .from("integration_sync_runs")
        .select(
          "id,entity,mode,status,started_at,finished_at,duration_ms,received,failed,message,period_from,period_to",
        )
        .eq("company_id", data.company)
        .order("started_at", { ascending: false })
        .limit(30),
    ]);
    if (ready.error) throw new Error("Não foi possível carregar a prontidão.");
    return {
      readiness: (ready.data ?? []) as unknown as ReadinessRow[],
      backfills: (jobs.data ?? []) as BackfillJob[],
      issues: (issues.data ?? []) as IntegrityIssue[],
      runs: runs.data ?? [],
    };
  });

export const manageBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    companySchema
      .extend({
        action: z.enum(["create", "pause", "resume", "cancel", "retry"]),
        entity: z.enum(["invoices", "orders", "receivables", "settlements"]).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        jobId: z.string().uuid().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("manage_backfill", {
      p_company: data.company,
      p_action: data.action,
      ...(data.entity ? { p_entity: data.entity } : {}),
      ...(data.from ? { p_from: data.from } : {}),
      ...(data.to ? { p_to: data.to } : {}),
      ...(data.jobId ? { p_job: data.jobId } : {}),
    });
    if (error) throw new Error(error.message || "Não foi possível atualizar o backfill.");
    return { ok: true };
  });

export const runIntegrityChecks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: n, error } = await context.supabase.rpc("run_integrity_checks", {
      p_company: data.company,
    });
    if (error) throw new Error("Não foi possível executar as checagens.");
    return { issues: n ?? 0 };
  });

export const resolveIntegrityIssue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        issueId: z.string().uuid(),
        status: z.enum(["ACKNOWLEDGED", "RESOLVED", "IGNORED"]),
        justification: z.string().trim().min(3).max(500),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("resolve_integrity_issue", {
      p_issue: data.issueId,
      p_status: data.status,
      p_justification: data.justification,
    });
    if (error) throw new Error(error.message || "Não foi possível registrar a decisão.");
    return { ok: true };
  });
