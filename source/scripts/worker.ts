/**
 * BIOMIE v2 worker: the only production process that loads Omie data.
 * Runs queued backfills, dimension requests, recurring refresh (when enabled)
 * and the daily Flight Plan snapshot in-process. Control with worker-ctl.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { initialWorkerState, workerConfig, workerTick } from "../src/lib/jobs/worker-core";
import { workerDependencies } from "../src/lib/jobs/worker.server";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (shutdown.signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      shutdown.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    shutdown.signal.addEventListener("abort", done, { once: true });
  });

try {
  const config = workerConfig(process.env);
  const deps = workerDependencies(supabaseAdmin, shutdown.signal);
  const state = initialWorkerState();
  deps.log({
    event: "started",
    commit: process.env["BIOMIE_GIT_COMMIT"] ?? null,
    intervalMs: config.intervalMs,
    tickBudgetMs: config.tickBudgetMs,
    maxLoadPerCpu: config.maxLoadPerCpu,
    blackouts: config.blackouts.map((window) => window.label),
  });
  deps.heartbeat();
  while (!shutdown.signal.aborted) {
    try {
      const result = await workerTick(config, deps, state);
      if (result.state !== "IDLE") deps.log({ event: "tick", ...result });
    } catch (error) {
      // Messages only: never print payloads, credentials or upstream bodies.
      deps.log({ event: "tick_failed", message: error instanceof Error ? error.message : "erro" });
      await deps.reportStatus({ state: "ERROR", at: new Date().toISOString() }).catch(() => {});
    }
    await sleep(config.intervalMs);
  }
  deps.log({ event: "stopped" });
} catch (error) {
  console.error(
    "Worker não iniciou:",
    error instanceof Error ? error.message : "configuração inválida",
  );
  process.exitCode = 1;
}
