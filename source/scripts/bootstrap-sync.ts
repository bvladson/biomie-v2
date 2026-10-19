/** Private administrative CLI. Scheduler/worker coordination belongs to ops17. */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import {
  bootstrapDependencies,
  parseBootstrapOptions,
  runBootstrap,
} from "../src/lib/omie/bootstrap.server";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
try {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const options = parseBootstrapOptions(process.argv.slice(2), today);
  const result = await runBootstrap(options, bootstrapDependencies(supabaseAdmin), shutdown.signal);
  console.log(
    JSON.stringify({
      job: "omie_bootstrap",
      status: result.interrupted ? "INTERRUPTED" : result.failures.length ? "FAILED" : "SUCCESS",
      failures: result.failures,
    }),
  );
  if (result.interrupted) process.exitCode = 130;
  else if (result.failures.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Bootstrap não concluído.");
  process.exitCode = 1;
}
