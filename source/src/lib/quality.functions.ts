import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { periodRegex } from "@/domain/filters";
import {
  getFreshness,
  getHealth,
  getJobRuns,
  getLatestReconciliation,
  runReconciliation,
} from "./repositories/quality.repository.server";

const companySchema = z.object({ company: z.string().uuid() });
const periodSchema = companySchema.extend({ period: z.string().regex(periodRegex) });

export const fetchFreshness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.parse(i))
  .handler(({ data, context }) => getFreshness(context.supabase, data.company));

export const fetchQualityJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.parse(i))
  .handler(({ data, context }) => getJobRuns(context.supabase, data.company));

export const fetchReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => periodSchema.parse(i))
  .handler(({ data, context }) =>
    getLatestReconciliation(context.supabase, data.company, data.period),
  );

export const triggerReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => periodSchema.parse(i))
  .handler(({ data, context }) => runReconciliation(context.supabase, data.company, data.period));

export const fetchHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => companySchema.parse(i))
  .handler(({ data, context }) => getHealth(context.supabase, data.company));
