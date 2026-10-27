/**
 * Importa os fornecedores do Omie (migração 0048) FORA do worker — para a HOMOLOGAÇÃO, que não tem worker:
 *   node .output/stock-suppliers-load.mjs [--minutes=30] [--empresa=<uuid>]
 * Pede uma importação para cada empresa conectada (ou só a indicada) e usa exatamente o passo do worker
 * (runStockSuppliersStep): mesmo limitador do Omie, mesmas regras de bloqueio e falha. Só LÊ o Omie; grava
 * no banco apontado por SUPABASE_URL. Para quando a fila acaba (ou só restam importações esperando nova
 * tentativa) ou quando o tempo acaba. Saída: um JSON por evento, sem credenciais.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { runStockSuppliersStep } from "../src/lib/omie/stock-suppliers.server";
import { stockStepDeps } from "../src/lib/omie/stock.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(args: string[]) {
  const minutesArg = args.find((a) => a.startsWith("--minutes="))?.split("=")[1];
  const minutes = Math.min(120, Math.max(1, Number(minutesArg ?? 30) || 30));
  const company = args.find((a) => a.startsWith("--empresa="))?.split("=")[1] ?? null;
  if (company !== null && !UUID.test(company)) throw new Error("empresa: use o id (uuid)");
  const deadline = Date.now() + minutes * 60_000;
  const deps = stockStepDeps(supabaseAdmin, (event) => console.log(JSON.stringify(event)));
  const { data: queued, error } = await deps.rpc("stock_worker_suppliers_enqueue", {
    p_company: company,
    p_trigger: "ops",
  });
  if (error) throw new Error("Falha ao pedir a importação de fornecedores.");
  console.log(JSON.stringify({ event: "load_queued", queued }));
  const tally: Record<string, number> = {};
  let steps = 0;
  while (Date.now() < deadline) {
    const r = await runStockSuppliersStep(deps, 60_000);
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
