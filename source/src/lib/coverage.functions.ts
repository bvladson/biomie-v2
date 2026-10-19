import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CoverageRange } from "@/domain/coverage";

export interface DataCoverageDTO {
  demo: boolean;
  entities: Partial<Record<"invoices" | "orders" | "receivables" | "settlements", CoverageRange[]>>;
}

/** Periods proven loaded per entity (RAW + Canonical + Gold), company access enforced in SQL. */
export const getDataCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ company: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: coverage, error } = await context.supabase.rpc(
      "data_coverage" as never,
      { p_company: data.company } as never,
    );
    if (error) throw new Error("Não foi possível consultar a cobertura dos dados.");
    return (coverage ?? { demo: false, entities: {} }) as unknown as DataCoverageDTO;
  });
