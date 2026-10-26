/**
 * Operação (homologação): a mesma carga do bootstrap-sync, registrando em JSON cada chamada ao Omie
 * (horário, método, resultado, registros, duração; só página e datas dos parâmetros). Serve para
 * provar, com o Omie real, o efeito de mudanças no ritmo das chamadas. Só LÊ o Omie (métodos Listar*).
 *   node .output/omie-trace-sync.mjs --phase=transactions --companies=<slug> --entities=a,b --from=... [--fresh]
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { TX_ADAPTERS } from "../src/lib/omie/adapters";
import {
  bootstrapDependencies,
  parseBootstrapOptions,
  runBootstrap,
} from "../src/lib/omie/bootstrap.server";
import { traceFetch } from "../src/lib/omie/trace";

// Instalado antes de qualquer cliente do Omie ser criado: o cliente lê o fetch global quando nasce,
// dentro da carga (o cliente do banco já foi criado e continua sem rastreio).
globalThis.fetch = traceFetch(globalThis.fetch, (event) => console.log(JSON.stringify(event)));

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
  if (options.phase !== "transactions")
    throw new Error("O rastreio é só para cargas transacionais.");
  // Só leitura: toda chamada destas entidades é um método Listar* do Omie.
  for (const entity of options.entities) {
    const call = TX_ADAPTERS[entity as keyof typeof TX_ADAPTERS]?.call ?? "";
    if (!/^Listar/.test(call)) throw new Error(`Entidade sem método de leitura: ${entity}`);
  }
  const result = await runBootstrap(options, bootstrapDependencies(supabaseAdmin), shutdown.signal);
  console.log(
    JSON.stringify({
      job: "omie_trace_sync",
      status: result.interrupted ? "INTERRUPTED" : result.failures.length ? "FAILED" : "SUCCESS",
      failures: result.failures,
    }),
  );
  if (result.interrupted) process.exitCode = 130;
  else if (result.failures.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Carga com rastreio não concluída.");
  process.exitCode = 1;
}
