import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

function friendly(error: { code?: string; message?: string }, what: string): Error {
  console.error(`${what} failed`, error);
  if (error.code === "42501") return new Error(error.message ?? "Sem acesso.");
  return new Error(`Não foi possível carregar ${what}.`);
}

export type FreshnessStatus = "FRESH" | "WARNING" | "STALE" | "FAILED";
export interface FreshnessRow {
  dataset: string;
  label: string;
  records: number;
  lastSync: string | null;
  lastTransform: string | null;
  martUpdated: string | null;
  ageHours: number | null;
  status: FreshnessStatus;
  error: string | null;
}
export interface FreshnessDTO {
  reference: string;
  warningHours: number;
  staleHours: number;
  isDemo: boolean;
  datasets: FreshnessRow[];
}

export async function getFreshness(sb: Client, company: string): Promise<FreshnessDTO> {
  const { data, error } = await sb.rpc("data_freshness", { p_company: company });
  if (error) throw friendly(error, "a atualização dos dados");
  return data as unknown as FreshnessDTO;
}

export interface JobRunRow {
  id: string;
  job: string;
  company: string | null;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  rows: number;
  status: "running" | "success" | "failed";
  error: string | null;
}

export async function getJobRuns(sb: Client, company: string): Promise<JobRunRow[]> {
  const { data, error } = await sb.rpc("quality_job_runs", { p_company: company });
  if (error) throw friendly(error, "as execuções de jobs");
  return (data as unknown as JobRunRow[]) ?? [];
}

export interface ReconciliationResult {
  id: string;
  dataset: string;
  check_key: string;
  check_name: string;
  period: string;
  source_count: number | null;
  source_value: number | null;
  target_count: number | null;
  target_value: number | null;
  abs_diff: number;
  pct_diff: number | null;
  status: "OK" | "WARNING" | "FAILED";
  rule: string;
}
export interface ReconciliationDTO {
  run: { id: string; period: string; startedAt: string; finishedAt: string | null } | null;
  results: ReconciliationResult[];
}

export async function getLatestReconciliation(
  sb: Client,
  company: string,
  period: string,
): Promise<ReconciliationDTO> {
  const { data: run, error } = await sb
    .from("reconciliation_runs")
    .select("id, period, started_at, finished_at")
    .eq("company_id", company)
    .eq("period", period)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw friendly(error, "a reconciliação");
  if (!run) return { run: null, results: [] };
  const { data: results, error: e2 } = await sb
    .from("reconciliation_results")
    .select(
      "id, dataset, check_key, check_name, period, source_count, source_value, target_count, target_value, abs_diff, pct_diff, status, rule",
    )
    .eq("run_id", run.id)
    .order("created_at");
  if (e2) throw friendly(e2, "a reconciliação");
  return {
    run: { id: run.id, period: run.period, startedAt: run.started_at, finishedAt: run.finished_at },
    results: (results ?? []).map((r) => ({
      ...r,
      source_value: r.source_value == null ? null : Number(r.source_value),
      target_value: r.target_value == null ? null : Number(r.target_value),
      abs_diff: Number(r.abs_diff),
      pct_diff: r.pct_diff == null ? null : Number(r.pct_diff),
    })) as ReconciliationResult[],
  };
}

export async function runReconciliation(sb: Client, company: string, period: string) {
  const { data, error } = await sb.rpc("run_reconciliation", {
    p_company: company,
    p_period: period,
  });
  if (error) throw friendly(error, "a reconciliação");
  return String(data);
}

export type HealthStatus = "ok" | "warning" | "error" | "not_configured";
export interface HealthCheck {
  key: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

/** Health checks — never return secret values, only presence/state. */
export async function getHealth(sb: Client, company: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [
    { key: "app", label: "Aplicação", status: "ok", detail: "Servidor respondendo." },
  ];
  const t0 = Date.now();
  const { error: dbErr } = await sb.rpc("data_as_of", { p_company: company });
  const ms = Date.now() - t0;
  checks.push({
    key: "db",
    label: "Banco de dados",
    status: dbErr ? "error" : ms > 1500 ? "warning" : "ok",
    detail: dbErr ? "Falha na consulta de teste." : `Consulta de teste em ${ms} ms.`,
  });

  const { data: sched } = await sb.rpc("scheduler_status");
  const s = (sched ?? {}) as {
    available?: boolean;
    jobs?: { job: string; active: boolean; lastStatus: string | null }[];
  };
  const jobs = s.jobs ?? [];
  checks.push({
    key: "scheduler",
    label: "Agendador",
    status: !s.available
      ? "warning"
      : jobs.some((j) => !j.active || j.lastStatus === "failed")
        ? "warning"
        : "ok",
    detail: !s.available
      ? "Status do agendador indisponível."
      : `${jobs.filter((j) => j.active).length} tarefa(s) agendada(s) ativa(s).`,
  });

  const runs = await getJobRuns(sb, company).catch(() => [] as JobRunRow[]);
  const lastByJob = new Map<string, JobRunRow>();
  for (const r of runs) if (!lastByJob.has(r.job)) lastByJob.set(r.job, r);
  const failed = [...lastByJob.values()].filter((r) => r.status === "failed");
  checks.push({
    key: "jobs",
    label: "Jobs",
    status: failed.length ? "error" : lastByJob.size ? "ok" : "warning",
    detail: failed.length
      ? `Última execução com falha: ${failed.map((f) => f.job).join(", ")}.`
      : lastByJob.size
        ? `${lastByJob.size} job(s) com última execução bem-sucedida.`
        : "Nenhuma execução registrada.",
  });

  const fresh = await getFreshness(sb, company).catch(() => null);
  const bad = fresh?.datasets.filter((d) => d.status !== "FRESH") ?? [];
  checks.push({
    key: "datasets",
    label: "Datasets",
    status: !fresh
      ? "error"
      : bad.some((d) => d.status === "FAILED" || d.status === "STALE")
        ? "error"
        : bad.length
          ? "warning"
          : "ok",
    detail: !fresh
      ? "Não foi possível avaliar."
      : bad.length
        ? `Atenção: ${bad.map((d) => `${d.label} (${d.status})`).join(", ")}.`
        : "Todos os datasets atualizados.",
  });

  const { data: integration, error: integrationError } = await sb
    .from("company_integrations")
    .select("status,last_test_ok,last_test_at")
    .eq("company_id", company)
    .eq("provider", "omie")
    .maybeSingle();
  checks.push({
    key: "omie",
    label: "API Omie",
    status: integrationError
      ? "warning"
      : !integration
        ? "not_configured"
        : integration.status === "ERROR" || integration.last_test_ok === false
          ? "error"
          : integration.last_test_ok === true
            ? "ok"
            : "warning",
    detail: integrationError
      ? "Status da integração indisponível para este perfil."
      : !integration
        ? "Ainda não configurada (aguardando credenciais)."
        : integration.last_test_ok === true
          ? "Último teste de conexão bem-sucedido. Confira a prontidão dos dados em Integrações."
          : "Integração configurada; teste de conexão pendente ou com falha.",
  });
  return checks;
}
