/** Separate VPS scheduler. Node 22.18+ or Bun; never run inside the web process. */
import { runScheduler, schedulerConfig } from "../src/lib/jobs/scheduler.ts";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
try {
  const config = schedulerConfig(process.env);
  console.log("BIOMIE worker iniciado; agendamento", config.snapshotHour, config.snapshotTimeZone);
  await runScheduler(config, shutdown.signal);
} catch {
  console.error(
    "Worker não iniciou. Verifique APP_BASE_URL, BIOMIE_JOB_TOKEN e as opções BIOMIE_WORKER/BIOMIE_SNAPSHOT.",
  );
  process.exitCode = 1;
}
