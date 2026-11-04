import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildFlightPlan, snapshotRows } from "@/lib/repositories/flight-plan.repository.server";
import { syncCompanyAlerts } from "@/lib/repositories/flight-plan-v2.repository.server";
import { acquireWorkerLease } from "./worker-lease.server";

type Client = SupabaseClient<Database>;
export const SNAPSHOT_JOB = "flight_plan_snapshots";

export interface SnapshotJobInput {
  companyIds?: string[];
  /** YYYY-MM-DD; default = data_as_of of each company (demo-aware). */
  date?: string;
  trigger: "cron" | "manual";
  triggeredBy?: string | null;
}

export interface SnapshotJobResult {
  runId: string;
  status: "success" | "failed";
  rows: number;
  companies: { id: string; date: string; rows: number; error?: string }[];
}

/**
 * Daily Flight Plan snapshot job. Idempotent: for each (company, date) the
 * previous rows are replaced, and a unique index on
 * (company, coalesce(seller), snapshot_date) prevents duplicates.
 * Must run with the service-role client (trusted server context only).
 */
export async function runSnapshotJob(
  admin: Client,
  input: SnapshotJobInput,
): Promise<SnapshotJobResult> {
  const release = await acquireWorkerLease(admin, "flight-plan:snapshots");
  if (!release) throw new Error("O job de snapshots já está em execução.");
  try {
    return await runSnapshotJobUnlocked(admin, input);
  } finally {
    await release();
  }
}

async function runSnapshotJobUnlocked(
  admin: Client,
  input: SnapshotJobInput,
): Promise<SnapshotJobResult> {
  const { data: run, error: runErr } = await admin
    .from("job_runs")
    .insert({
      job_name: SNAPSHOT_JOB,
      params: { companyIds: input.companyIds ?? "all", date: input.date ?? "data_as_of" },
      status: "running",
      trigger: input.trigger,
      triggered_by: input.triggeredBy ?? null,
    })
    .select("id")
    .single();
  if (runErr || !run) throw new Error("Não foi possível registrar o job.");

  let companiesQ = admin.from("companies").select("id").order("name");
  if (input.companyIds?.length) companiesQ = companiesQ.in("id", input.companyIds);
  const { data: companies, error: companiesError } = await companiesQ;
  if (companiesError || !companies?.length) {
    await admin
      .from("job_runs")
      .update({
        status: "failed",
        error: "Não foi possível listar as empresas para o snapshot.",
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    throw new Error("Não foi possível listar as empresas para o snapshot.");
  }

  const results: SnapshotJobResult["companies"] = [];
  for (const c of companies ?? []) {
    let date = input.date ?? "";
    try {
      if (!date) {
        const { data: asOf, error: asOfError } = await admin.rpc("data_as_of", { p_company: c.id });
        if (asOfError || typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf))
          throw new Error("Não foi possível resolver a data de referência da empresa.");
        date = String(asOf);
      }
      const period = date.slice(0, 7);
      const dto = await buildFlightPlan(admin, { company: c.id, period }, date);
      const rows = snapshotRows(c.id, period, dto).map((r) => ({ ...r, job_run_id: run.id }));
      // A single SQL transaction replaces the date. An insertion failure keeps
      // the previous snapshot, including when the process dies mid-request.
      const db = admin as unknown as {
        rpc: (
          name: string,
          args: Record<string, unknown>,
        ) => PromiseLike<{ error: { message: string } | null }>;
      };
      const { error: replaceError } = await db.rpc("replace_flight_plan_snapshot", {
        p_company: c.id,
        p_date: date,
        p_rows: rows,
      });
      if (replaceError) throw new Error("Falha ao substituir o snapshot atomicamente.");
      results.push({ id: c.id, date, rows: rows.length });
      // Presença diária dos alertas da empresa (um Resolvido que some e volta reabre). Não derruba a foto.
      try {
        await syncCompanyAlerts(admin, c.id, period, date);
      } catch {
        console.error(`[${SNAPSHOT_JOB}] company ${c.id}: presença dos alertas não registrada`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : ((e as { message?: string })?.message ?? "erro");
      console.error(`[${SNAPSHOT_JOB}] company ${c.id} failed`);
      results.push({ id: c.id, date, rows: 0, error: msg });
    }
  }

  const rows = results.reduce((a, r) => a + r.rows, 0);
  const failed = results.filter((r) => r.error);
  const status = failed.length ? "failed" : "success";
  const { error: finishError } = await admin
    .from("job_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      rows_written: rows,
      error: failed.length ? failed.map((f) => `${f.id}: ${f.error}`).join("; ") : null,
      params: {
        companyIds: input.companyIds ?? "all",
        date: input.date ?? "data_as_of",
        results,
      },
    })
    .eq("id", run.id);
  if (finishError) throw new Error("Não foi possível registrar o resultado do job de snapshots.");
  console.log(`[${SNAPSHOT_JOB}] run ${run.id} ${status} rows=${rows}`);
  return { runId: run.id, status, rows, companies: results };
}
