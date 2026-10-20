import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MAX_TARGET, TARGET_LEVELS, type GridSeller } from "@/domain/targets/grid";
import type { TargetLevel } from "@/domain/flight-plan/config";

/**
 * Targets editor. Both calls run with the signed-in user's own session: the
 * database functions read auth.uid() and enforce the scope (admins of the
 * company, or the manager of the seller's team). No service key on this path.
 */
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };

const period = {
  company: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
};

export interface TargetsGrid {
  canEdit: boolean;
  /** Level the Cockpit and the Plano de Voo use as "the" target. */
  activeLevel: TargetLevel;
  sellers: GridSeller[];
}

const amounts = (value: unknown): Partial<Record<TargetLevel, number>> => {
  const out: Partial<Record<TargetLevel, number>> = {};
  const record = (value ?? {}) as Record<string, unknown>;
  for (const level of TARGET_LEVELS)
    if (record[level] != null && Number.isFinite(Number(record[level])))
      out[level] = Number(record[level]);
  return out;
};

export const fetchTargetsGrid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object(period).parse(input))
  .handler(async ({ data, context }): Promise<TargetsGrid> => {
    const { data: grid, error } = await (context.supabase as unknown as Rpc).rpc(
      "sales_targets_grid",
      { p_company: data.company, p_year: data.year, p_month: data.month },
    );
    if (error)
      throw new Error(
        error.code === "42501"
          ? "Sem acesso a esta empresa."
          : "Não foi possível carregar as metas.",
      );
    const raw = (grid ?? {}) as {
      canEdit?: boolean;
      activeLevel?: string;
      sellers?: Record<string, unknown>[];
    };
    return {
      canEdit: raw.canEdit === true,
      activeLevel: TARGET_LEVELS.includes(raw.activeLevel as TargetLevel)
        ? (raw.activeLevel as TargetLevel)
        : "ACTIVE",
      sellers: (raw.sellers ?? []).map((s) => ({
        id: String(s["id"]),
        name: String(s["name"] ?? ""),
        team: s["team"] == null ? null : String(s["team"]),
        active: s["active"] !== false,
        editable: s["editable"] === true,
        targets: amounts(s["targets"]),
        previous: amounts(s["previous"]),
      })),
    };
  });

export const saveTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        ...period,
        rows: z
          .array(
            z.object({
              seller: z.string().uuid(),
              level: z.enum(["BASE", "ACTIVE", "CHALLENGE"]),
              amount: z.number().min(0).max(MAX_TARGET).nullable(),
            }),
          )
          .min(1)
          .max(3000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: result, error } = await (context.supabase as unknown as Rpc).rpc(
      "save_sales_targets",
      { p_company: data.company, p_year: data.year, p_month: data.month, p_rows: data.rows },
    );
    if (error) {
      if (error.code === "42501")
        throw new Error(
          error.message?.includes("vendedor")
            ? "Você não pode alterar a meta de algum vendedor desta lista. Nada foi salvo."
            : "Sem acesso a esta empresa. Nada foi salvo.",
        );
      if (error.code === "22023")
        throw new Error(`${error.message ?? "Dados inválidos"}. Nada foi salvo.`);
      throw new Error("Não foi possível salvar as metas. Nada foi salvo.");
    }
    const r = (result ?? {}) as { saved?: number; deleted?: number; unchanged?: number };
    return { saved: r.saved ?? 0, deleted: r.deleted ?? 0, unchanged: r.unchanged ?? 0 };
  });
