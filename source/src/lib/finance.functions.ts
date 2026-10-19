import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyticsQuerySchema } from "@/domain/filters";
import {
  getCustomerFinance,
  getFinanceSummary,
  getFinanceTitles,
  getMyFinanceCapabilities,
} from "./repositories/finance.repository.server";

export const fetchFinanceCapabilities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => getMyFinanceCapabilities(context.supabase, context.userId));

export const fetchFinanceSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.parse(i))
  .handler(({ data, context }) => getFinanceSummary(context.supabase, data));

export const fetchFinanceTitles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.parse(i))
  .handler(({ data, context }) => getFinanceTitles(context.supabase, data));

export const fetchCustomerFinance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ company: z.string().uuid(), customer: z.string().uuid() }).parse(i),
  )
  .handler(({ data, context }) =>
    getCustomerFinance(context.supabase, data.company, data.customer),
  );

/**
 * Export gate: checked server-side and audited before the browser builds the
 * file from the data already on screen.
 */
export const authorizeFinanceExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        company: z.string().uuid(),
        kind: z.string().max(40),
        rows: z.number().int().min(0),
        format: z.enum(["csv", "xlsx"]),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { error: accessError } = await context.supabase.rpc("finance_assert", {
      p_company: data.company,
      p_cap: "finance.export",
    });
    if (accessError) throw new Error("Sem permissão para exportar dados financeiros.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("audit_log").insert({
      actor_id: context.userId,
      action: "finance.export",
      entity: "financial_titles",
      entity_id: data.company,
      payload: { kind: data.kind, rows: data.rows, format: data.format },
    });
    if (error) throw new Error("Não foi possível auditar a exportação financeira.");
    return { ok: true };
  });
