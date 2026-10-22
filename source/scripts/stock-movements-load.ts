/**
 * Processa a fila de movimentações do estoque (migração 0043) FORA do worker — para a
 * HOMOLOGAÇÃO, que não tem worker (na produção quem faz isso é o worker):
 *   node .output/stock-movements-load.mjs [--minutes=90]
 * Usa exatamente o passo do worker (runStockMovementsStep): mesmo limitador do Omie, mesmas regras
 * de bloqueio e falha, mesmo recálculo das curvas ao fim de cada empresa. Só LÊ o Omie; grava no
 * banco apontado por SUPABASE_URL. Para quando a fila acaba (ou só restam blocos esperando nova
 * tentativa) ou quando o tempo acaba. Saída: um JSON por evento, sem credenciais.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { runStockMovementsStep } from "../src/lib/omie/stock-movements.server";
import { stockStepDeps } from "../src/lib/omie/stock.server";

async function main(args: string[]) {
  const minutesArg = args.find((a) => a.startsWith("--minutes="))?.split("=")[1];
  const minutes = Math.min(240, Math.max(1, Number(minutesArg ?? 90) || 90));
  const deadline = Date.now() + minutes * 60_000;
  const deps = stockStepDeps(supabaseAdmin, (event) => console.log(JSON.stringify(event)));
  const tally: Record<string, number> = {};
  let steps = 0;
  while (Date.now() < deadline) {
    const r = await runStockMovementsStep(deps, 60_000);
    if (!r.jobId) break;
    steps++;
    tally[r.status ?? "?"] = (tally[r.status ?? "?"] ?? 0) + 1;
    if (r.status === "BUSY") await new Promise((done) => setTimeout(done, 15_000));
  }
  console.log(
    JSON.stringify({ event: "load_end", steps, tally, timedOut: Date.now() >= deadline }),
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "falha");
  process.exitCode = 1;
});
