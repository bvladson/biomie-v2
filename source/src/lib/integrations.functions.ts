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
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("set_integration_credentials", {
      p_company: data.company,
      p_provider: "omie",
      p_app_key: data.appKey,
      p_app_secret: data.appSecret,
    });
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
    const { runSyncStep } = await import("./omie/sync.server");
    return runSyncStep(await admin(), {
      company: data.company,
      entity: data.entity,
      ...(data.runId ? { runId: data.runId } : {}),
      userId: context.userId,
    });
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
        entity: z.enum(["invoices", "orders", "receivables"]).optional(),
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
