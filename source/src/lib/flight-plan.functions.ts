import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyticsQuerySchema, periodRegex } from "@/domain/filters";
import {
  buildFlightPlan,
  setActionStatus,
  upsertCommit,
} from "./repositories/flight-plan.repository.server";

/** One aggregated read: summary + timeline + vendors + actions (no per-seller requests). */
export const getFlightPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => analyticsQuerySchema.parse(input))
  .handler(async ({ data, context }) => buildFlightPlan(context.supabase, data));

/** Individual flight plan = same read model scoped to one seller (RLS still applies). */
export const getVendorFlightPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    analyticsQuerySchema.extend({ seller: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => buildFlightPlan(context.supabase, data));

export const saveCommit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        company: z.string().uuid(),
        seller: z.string().uuid(),
        period: z.string().regex(periodRegex),
        amount: z.number().min(0).max(1e11),
        note: z.string().trim().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => upsertCommit(context.supabase, data));

export const updateActionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        company: z.string().uuid(),
        period: z.string().regex(periodRegex),
        seller: z.string().uuid().nullable(),
        type: z.string().max(40),
        priority: z.number().int().min(1).max(3),
        message: z.string().max(300),
        status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => setActionStatus(context.supabase, data));
