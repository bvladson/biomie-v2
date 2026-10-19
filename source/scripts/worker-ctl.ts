/**
 * Worker control (run inside the web or worker container):
 *   node .output/worker-ctl.mjs status
 *   node .output/worker-ctl.mjs pause "motivo"
 *   node .output/worker-ctl.mjs resume
 *   node .output/worker-ctl.mjs recurring on|off
 *   node .output/worker-ctl.mjs queue
 *   node .output/worker-ctl.mjs enqueue <company-slug|all> <entity> [from YYYY-MM-DD] [to YYYY-MM-DD]
 *   node .output/worker-ctl.mjs cancel-pending <company-slug|all> [entity]
 * Start/stop of the process itself: docker compose start|stop worker.
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";

// Operational RPCs/tables added after the generated types.
const db = supabaseAdmin as unknown as {
  rpc: (
    f: string,
    a?: unknown,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const TX = ["invoices", "orders", "receivables", "settlements"];
const DIM = ["vendors", "customers", "products"];

async function companies(selector: string): Promise<{ id: string; slug: string }[]> {
  const query = db.from("companies").select("id,slug").eq("is_demo", false).order("slug");
  const { data, error } = selector === "all" ? await query : await query.eq("slug", selector);
  if (error || !data?.length) throw new Error(`Empresa não encontrada: ${selector}`);
  return data;
}

const months = (from: string, to: string) =>
  Number(to.slice(0, 4)) * 12 +
  Number(to.slice(5, 7)) -
  (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7))) +
  1;

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === "status") {
    const { data, error } = await db.rpc("worker_status");
    if (error) throw new Error(error.message);
    return out(data);
  }
  if (command === "pause" || command === "resume") {
    const { data, error } = await db.rpc("set_worker_control", {
      p_paused: command === "pause",
      p_reason: rest.join(" ") || (command === "pause" ? "pausa manual" : "retomada manual"),
    });
    if (error) throw new Error(error.message);
    return out(data);
  }
  if (command === "recurring" && ["on", "off"].includes(rest[0] ?? "")) {
    const { data, error } = await db.rpc("set_worker_control", {
      p_recurring: rest[0] === "on",
      p_reason: `recorrência ${rest[0]}`,
    });
    if (error) throw new Error(error.message);
    return out(data);
  }
  if (command === "queue") {
    const { data, error } = await db
      .from("integration_backfill_jobs")
      .select(
        "id,company_id,entity,period_from,period_to,status,partitions_done,partitions_total,priority,last_error,updated_at",
      )
      .in("status", ["PENDING", "RUNNING", "PAUSED", "FAILED"])
      .order("priority")
      .order("created_at");
    if (error) throw new Error(error.message);
    return out(data);
  }
  if (command === "enqueue" && rest.length >= 2) {
    const [selector, entity, from, to] = rest as [string, string, string?, string?];
    if (![...TX, ...DIM].includes(entity)) throw new Error("Entidade inválida.");
    const today = new Date().toISOString().slice(0, 10);
    const dimension = DIM.includes(entity);
    const periodFrom = dimension ? today : (from ?? "");
    const periodTo = dimension ? today : (to ?? today);
    if (!dimension && !/^\d{4}-\d{2}-\d{2}$/.test(periodFrom))
      throw new Error("Informe from YYYY-MM-DD.");
    const created = [];
    for (const company of await companies(selector)) {
      const { data, error } = await db
        .from("integration_backfill_jobs")
        .insert({
          company_id: company.id,
          entity,
          period_from: periodFrom,
          period_to: periodTo,
          priority: 100,
          partitions_total: dimension ? 1 : months(periodFrom, periodTo),
          current_partition: dimension ? null : `${periodFrom.slice(0, 7)}-01`,
          created_by: null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      created.push({ company: company.slug, entity, from: periodFrom, to: periodTo, job: data.id });
    }
    return out(created);
  }
  if (command === "cancel-pending" && rest.length >= 1) {
    const [selector, entity] = rest as [string, string?];
    const ids = (await companies(selector)).map((c) => c.id);
    let query = db
      .from("integration_backfill_jobs")
      .update({ status: "CANCELLED", updated_at: new Date().toISOString() })
      .in("company_id", ids)
      .in("status", ["PENDING", "PAUSED"]);
    if (entity) query = query.eq("entity", entity);
    const { data, error } = await query.select("id");
    if (error) throw new Error(error.message);
    return out({ cancelled: data?.length ?? 0 });
  }
  throw new Error(
    "Uso: status | pause [motivo] | resume | recurring on|off | queue | enqueue | cancel-pending",
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "falha");
  process.exitCode = 1;
});
