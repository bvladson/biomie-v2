import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  ENTITY_ORDER,
  TX_ORDER,
  type OmieEntity,
  type OmieTxEntity,
  type Period,
} from "./adapters";
import { OmieError } from "./omie-client";
import { runSyncStep, type SyncStepResult } from "./sync.server";
import { runTxSyncStep, type TxStepResult } from "./sync-tx.server";

type Entity = OmieEntity | OmieTxEntity;
export interface BootstrapOptions {
  phase: "dimensions" | "transactions";
  companies: string[];
  entities: Entity[];
  period: Period;
  maxSteps: number;
  budgetMs: number;
  delayMs: number;
  resumeFailed: boolean;
  fresh: boolean;
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function parseBootstrapOptions(args: string[], today: string): BootstrapOptions {
  const values: Record<string, string> = {};
  const allowed = new Set([
    "phase",
    "companies",
    "entities",
    "from",
    "to",
    "max-steps",
    "budget-ms",
    "delay-ms",
    "resume-failed",
    "fresh",
  ]);
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !allowed.has(match[1]!) || Object.hasOwn(values, match[1]!))
      throw new Error(`Opção inválida ou repetida: ${arg.split("=")[0]}`);
    values[match[1]!] = match[2] ?? "true";
  }
  const phase = values["phase"] ?? "dimensions";
  if (phase !== "dimensions" && phase !== "transactions")
    throw new Error("phase deve ser dimensions ou transactions.");
  const order = phase === "dimensions" ? ENTITY_ORDER : TX_ORDER;
  const selected = values["entities"]?.split(",").map((v) => v.trim()) ?? order;
  if (!selected.length || selected.some((entity) => !(order as string[]).includes(entity)))
    throw new Error("Entidade inválida para esta fase.");
  const from = values["from"] ?? "2026-01-01";
  const to = values["to"] ?? today;
  if (!validDate(from) || !validDate(to) || from > to)
    throw new Error("Período inválido; use YYYY-MM-DD com from <= to.");
  const number = (key: string, fallback: number, min: number, max: number) => {
    const result = values[key] === undefined ? fallback : Number(values[key]);
    if (!Number.isInteger(result) || result < min || result > max)
      throw new Error(`Opção numérica inválida: ${key}`);
    return result;
  };
  const flag = (key: string) => {
    if (values[key] !== undefined && !["true", "false"].includes(values[key]!))
      throw new Error(`Opção booleana inválida: ${key}`);
    return values[key] === "true";
  };
  const companies =
    values["companies"]
      ?.split(",")
      .map((v) => v.trim())
      .filter(Boolean) ?? [];
  if (values["companies"] !== undefined && !companies.length)
    throw new Error("companies não pode ser vazio.");
  return {
    phase,
    companies,
    entities: order.filter((entity) => selected.includes(entity)),
    period: { from, to },
    maxSteps: number("max-steps", 2000, 1, 100_000),
    budgetMs: number("budget-ms", 15_000, 1, 60_000),
    delayMs: number("delay-ms", 750, 0, 60_000),
    resumeFailed: flag("resume-failed"),
    fresh: flag("fresh"),
  };
}

export interface BootstrapRun {
  id: string;
  status: string;
  mode: string;
  period_from: string | null;
  period_to: string | null;
  backfill_job_id: string | null;
  checkpoint_end: unknown;
}

export function bootstrapResume(
  run: BootstrapRun | null,
  options: BootstrapOptions,
): { runId?: string; waitMs: number } {
  if (!run || ["SUCCESS", "WARNING"].includes(run.status)) return { waitMs: 0 };
  if (run.status !== "RUNNING" && options.fresh) return { waitMs: 0 };
  if (run.backfill_job_id)
    throw new Error(
      "A execução pertence à fila de backfill; retome pela fila para respeitar PAUSED/CANCELLED.",
    );
  if (
    (options.phase === "dimensions" && run.mode !== "FULL") ||
    (options.phase === "transactions" &&
      (run.mode !== "PERIOD" ||
        run.period_from !== options.period.from ||
        run.period_to !== options.period.to))
  )
    throw new Error(
      "A execução pendente tem fase/período diferente. Conclua-a antes de iniciar outro período.",
    );
  const checkpoint = run.checkpoint_end as { retryAt?: unknown } | null;
  const retryAt = typeof checkpoint?.retryAt === "string" ? Date.parse(checkpoint.retryAt) : NaN;
  const retryScheduled = Number.isFinite(retryAt);
  if (run.status === "FAILED" && !options.resumeFailed && !retryScheduled)
    throw new Error(
      "Falha permanente pendente. Corrija a causa e use --resume-failed ou --fresh explicitamente.",
    );
  return { runId: run.id, waitMs: retryScheduled ? Math.max(0, retryAt - Date.now()) : 0 };
}

interface Company {
  id: string;
  slug: string;
}
interface StepInput {
  company: string;
  entity: Entity;
  runId?: string;
  userId: null;
  budgetMs: number;
}
export interface BootstrapDependencies {
  companies(): Promise<Company[]>;
  latestRun(company: string, entity: Entity): Promise<BootstrapRun | null>;
  step(input: StepInput, options: BootstrapOptions): Promise<SyncStepResult | TxStepResult>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(event: Record<string, unknown>): void;
}

/** Bounded, resumable CLI. An entity failure never hides the remaining companies. */
export async function runBootstrap(
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
  signal: AbortSignal,
) {
  const companies = await dependencies.companies();
  const missing = options.companies.filter(
    (key) => !companies.some((company) => company.id === key || company.slug === key),
  );
  if (missing.length) throw new Error(`Empresa não encontrada: ${missing.join(", ")}`);
  const failures: { company: string; entity: string; message: string }[] = [];
  for (const company of companies.filter(
    (c) =>
      !options.companies.length ||
      options.companies.includes(c.id) ||
      options.companies.includes(c.slug),
  )) {
    for (const entity of options.entities) {
      if (signal.aborted) return { failures, interrupted: true };
      try {
        const resume = bootstrapResume(await dependencies.latestRun(company.id, entity), options);
        let runId = resume.runId;
        if (resume.waitMs) await dependencies.sleep(resume.waitMs, signal);
        let complete = false;
        for (let step = 0; step < options.maxSteps && !signal.aborted; step++) {
          let result: SyncStepResult | TxStepResult;
          try {
            result = await dependencies.step(
              {
                company: company.id,
                entity,
                userId: null,
                budgetMs: options.budgetMs,
                ...(runId ? { runId } : {}),
              },
              options,
            );
          } catch (error) {
            if (!(error instanceof OmieError && error.retriable)) throw error;
            await dependencies.sleep(Math.max(options.delayMs, 5_000), signal);
            continue;
          }
          runId = result.runId;
          dependencies.log({
            company: company.slug,
            entity,
            step,
            runId,
            done: result.done,
            status: result.status,
            received: result.received,
          });
          if (result.status === "FAILED") {
            if (!result.retryable)
              throw new Error(`Execução FAILED: ${runId}; confira o histórico privado.`);
            await dependencies.sleep(result.retryAfterMs ?? 30_000, signal);
          } else if (result.done) {
            complete = true;
            break;
          } else await dependencies.sleep(options.delayMs, signal);
        }
        if (signal.aborted) return { failures, interrupted: true };
        if (!complete)
          throw new Error(
            `Limite de ${options.maxSteps} passos atingido; checkpoint preservado em ${runId ?? "execução concorrente"}.`,
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha inesperada no bootstrap.";
        failures.push({ company: company.slug, entity, message });
        dependencies.log({ company: company.slug, entity, status: "FAILED", message });
      }
    }
  }
  return { failures, interrupted: signal.aborted };
}

export function bootstrapDependencies(admin: SupabaseClient<Database>): BootstrapDependencies {
  return {
    async companies() {
      const { data, error } = await admin
        .from("companies")
        .select("id,slug")
        .eq("is_demo", false)
        .order("slug");
      if (error || !data) throw new Error("Não foi possível carregar as empresas.");
      return data;
    },
    async latestRun(company, entity) {
      const query = () =>
        admin
          .from("integration_sync_runs")
          .select("id,status,mode,period_from,period_to,backfill_job_id,checkpoint_end")
          .eq("company_id", company)
          .eq("entity", entity);
      const active = await query().eq("status", "RUNNING").maybeSingle();
      if (active.error) throw new Error("Não foi possível consultar a execução RUNNING.");
      if (active.data) return active.data;
      const latest = await query().order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (latest.error) throw new Error("Não foi possível consultar o checkpoint anterior.");
      return latest.data;
    },
    step(input, options) {
      return options.phase === "dimensions"
        ? runSyncStep(admin, { ...input, entity: input.entity as OmieEntity })
        : runTxSyncStep(admin, {
            ...input,
            entity: input.entity as OmieTxEntity,
            period: options.period,
          });
    },
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
      }),
    log: (event) => console.log(JSON.stringify(event)),
  };
}
