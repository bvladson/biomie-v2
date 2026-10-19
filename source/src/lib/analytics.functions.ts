import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyticsQuerySchema } from "@/domain/filters";
import { fetchCockpit, fetchFilterOptions } from "./repositories/analytics.repository.server";

export const getCockpit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => analyticsQuerySchema.parse(input))
  .handler(async ({ data, context }) => fetchCockpit(context.supabase, data));

export const getFilterOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ company: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => fetchFilterOptions(context.supabase, data.company));
