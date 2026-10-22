import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { bootstrapDependencies, runBootstrap } from "@/lib/omie/bootstrap.server";
import { runBackfillTick } from "@/lib/omie/sync-tx.server";
import {
  enqueueStockReadings,
  readStockSchedule,
  runStockStep,
  stockStepDeps,
} from "@/lib/omie/stock.server";
import { runStockMovementsStep } from "@/lib/omie/stock-movements.server";
import type { OmieEntity } from "@/lib/omie/adapters";
import { runSnapshotJob } from "./flight-plan-snapshots.server";
import type { WorkerControl, WorkerDeps } from "./worker-core";

type Admin = SupabaseClient<Database>;
// Operational RPCs/tables added after the generated types.
type Loose = { from: (t: string) => any; rpc: (f: string, a?: unknown) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const HEARTBEAT_FILE = "/tmp/biomie-worker-heartbeat";
const DIMENSIONS: OmieEntity[] = ["vendors", "customers", "products"];
const TRANSACTIONS = ["invoices", "orders", "receivables", "settlements"] as const;

const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const monthsBetween = (from: string, to: string) =>
  Number(to.slice(0, 4)) * 12 +
  Number(to.slice(5, 7)) -
  (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7))) +
  1;

/** Companies the worker may call: real, Omie-sourced and proven CONNECTED. */
async function connectedCompanies(admin: Admin): Promise<string[]> {
  const db = admin as unknown as Loose;
  const { data, error } = await db
    .from("company_integrations")
    .select("company_id,status,companies!inner(is_demo,data_source)")
    .eq("provider", "omie")
    .eq("status", "CONNECTED");
  if (error) throw new Error("Não foi possível listar as integrações conectadas.");
  return (data ?? [])
    .filter(
      (row: { companies: { is_demo: boolean; data_source: string } }) =>
        !row.companies.is_demo && ["OMIE_SHADOW", "OMIE"].includes(row.companies.data_source),
    )
    .map((row: { company_id: string }) => row.company_id);
}

export function workerDependencies(admin: Admin, signal: AbortSignal): WorkerDeps {
  const db = admin as unknown as Loose;
  const log = (event: Record<string, unknown>) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), process: "worker", ...event }));
  const heartbeat = () => {
    try {
      writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    } catch {
      /* the healthcheck reports the stale heartbeat */
    }
  };

  return {
    now: () => new Date(),
    log,
    heartbeat,
    // Host-wide ratio: loadavg is the host's, so divide by the host CPU count
    // (availableParallelism() reflects the container quota and inflates the ratio).
    loadAverage: () => ({ load1: loadavg()[0] ?? 0, cpus: Math.max(1, cpus().length) }),

    async readControl(): Promise<WorkerControl> {
      const { data, error } = await db.rpc("get_worker_control");
      if (error || !data || typeof data !== "object")
        throw new Error("Controle do worker indisponível.");
      const value = data as Record<string, unknown>;
      return {
        paused: value["paused"] === true,
        recurring: value["recurring"] === true,
        ...(typeof value["reason"] === "string" && value["reason"]
          ? { reason: value["reason"] }
          : {}),
      };
    },

    async reportStatus(status) {
      const { error } = await db.rpc("report_worker_status", {
        p_status: { ...status, commit: process.env["BIOMIE_GIT_COMMIT"] ?? null },
      });
      if (error) log({ event: "status_report_failed" });
    },

    async runDimensionJob() {
      const { data: jobs, error } = await db
        .from("integration_backfill_jobs")
        .select("id,company_id,entity,status")
        .in("status", ["PENDING", "RUNNING"])
        .in("entity", DIMENSIONS)
        .order("priority")
        .order("created_at")
        .limit(1);
      if (error) throw new Error("Falha ao consultar pedidos de cadastro.");
      const job = jobs?.[0];
      if (!job) return { jobId: null };
      const { data: claimed } = await db
        .from("integration_backfill_jobs")
        .update({ status: "RUNNING", updated_at: new Date().toISOString() })
        .eq("id", job.id)
        .in("status", ["PENDING", "RUNNING"])
        .select("id")
        .maybeSingle();
      if (!claimed) return { jobId: null };
      const today = new Date().toISOString().slice(0, 10);
      const result = await runBootstrap(
        {
          phase: "dimensions",
          companies: [job.company_id],
          entities: [job.entity],
          period: { from: today, to: today },
          maxSteps: 2000,
          budgetMs: 15_000,
          delayMs: 750,
          resumeFailed: false,
          fresh: true,
        },
        {
          ...bootstrapDependencies(admin),
          log: (event) => (heartbeat(), log({ job: job.id, ...event })),
        },
        signal,
      );
      const failed = result.failures.length > 0;
      await db
        .from("integration_backfill_jobs")
        .update({
          status: result.interrupted ? "PENDING" : failed ? "FAILED" : "DONE",
          partitions_done: failed || result.interrupted ? 0 : 1,
          last_error: failed
            ? result.failures
                .map((f) => f.message)
                .join(" | ")
                .slice(0, 500)
            : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      return { jobId: job.id, status: failed ? "FAILED" : "SUCCESS", done: true };
    },

    async runBackfillStep() {
      const tick = await runBackfillTick(admin);
      return {
        jobId: tick.jobId,
        status: tick.result?.status ?? null,
        done: tick.result?.done ?? true,
      };
    },

    async enqueueRecurring(kind, today) {
      // Daily dimensions and the weekly replay run once per local day even when
      // the worker restarts (its in-memory state starts empty after a release).
      if (kind !== "transactions") {
        const base = db
          .from("integration_backfill_jobs")
          .select("id", { count: "exact", head: true });
        const { count, error } =
          kind === "dimensions"
            ? await base.in("entity", [...DIMENSIONS]).eq("period_from", today)
            : await base
                .in("entity", [...TRANSACTIONS])
                .eq("period_to", today)
                .eq("priority", 250);
        if (!error && count) {
          log({ event: "recurring_skipped", kind, reason: "already enqueued today" });
          return 0;
        }
      }
      const companies = await connectedCompanies(admin);
      const entities = kind === "dimensions" ? DIMENSIONS : [...TRANSACTIONS];
      const from =
        kind === "dimensions"
          ? today
          : kind === "replay"
            ? `${today.slice(0, 4)}-01-01`
            : addDays(today, -Number(process.env["BIOMIE_RECURRING_TX_DAYS"] ?? 62));
      const priority = kind === "dimensions" ? 150 : kind === "replay" ? 250 : 200;
      let created = 0;
      for (const company of companies) {
        for (const entity of entities) {
          const { count } = await db
            .from("integration_backfill_jobs")
            .select("id", { count: "exact", head: true })
            .eq("company_id", company)
            .eq("entity", entity)
            .in("status", ["PENDING", "RUNNING", "PAUSED"]);
          if (count) continue;
          const dimension = kind === "dimensions";
          const { error } = await db.from("integration_backfill_jobs").insert({
            company_id: company,
            entity,
            period_from: dimension ? today : from,
            period_to: today,
            priority,
            partitions_total: dimension ? 1 : monthsBetween(from, today),
            current_partition: dimension ? null : `${from.slice(0, 7)}-01`,
            created_by: null,
          });
          if (!error) created++;
        }
      }
      log({ event: "recurring_enqueued", kind, created });
      return created;
    },

    async runSnapshot() {
      try {
        const result = await runSnapshotJob(admin, { trigger: "cron" });
        log({ event: "snapshot", status: result.status, rows: result.rows });
        return result.status === "success";
      } catch (error) {
        log({ event: "snapshot_failed", message: error instanceof Error ? error.message : "erro" });
        return false;
      }
    },

    // Estoque (migração 0041): só lê quando a leitura está ligada no banco.
    stockSchedule: () => readStockSchedule(admin),
    enqueueStock: async (slot, kind, day) => {
      const created = await enqueueStockReadings(admin, slot, kind, day);
      log({ event: "stock_enqueued", slot, kind, created });
      return created;
    },
    // Uma etapa de estoque por ciclo: a leitura agendada tem prioridade; sem leitura na fila,
    // avança as movimentações (0043), quando ligadas no banco (sem fila, nada é chamado no Omie).
    runStockStep: async () => {
      const deps = stockStepDeps(admin, (event) => (heartbeat(), log(event)));
      const step = await runStockStep(deps, 15_000);
      return step.jobId ? step : runStockMovementsStep(deps, 15_000);
    },
  };
}
