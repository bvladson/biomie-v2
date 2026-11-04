import { describe, expect, it } from "vitest";
import { createMockFlightPlan } from "../api/mock";
import type { TargetLevel } from "../api/contract";
import { adjustedUndistributed, displayOrder, nextEditable, planPaste } from "../lib/targets-grid";
import type { FlightPlanApi, PlanQuery } from "../api/contract";
import {
  missingTargetLabel,
  partialPeriod,
  quarterOf,
  saturdayNote,
  workdaysLabel,
  yearOf,
} from "../lib/period";

const LEVELS: TargetLevel[] = ["BASE", "ACTIVE", "CHALLENGE"];

/** Os meses pedidos, tirados do plano do mês da consulta (FlightPlan.months). */
async function loadPeriodMonths(api: FlightPlanApi, q: PlanQuery, months: string[]) {
  const plan = await api.getPlan(q);
  return plan.months.filter((r) => months.includes(r.month));
}

async function magFilialGrid(persona: "ADMIN" | "GESTOR" = "ADMIN") {
  const m = createMockFlightPlan({ latency: [0, 0], errorRate: 0 });
  m.setPersona(persona);
  const t = await m.api.getTargets("mag-filial", "2026-11");
  const grid = t.sellers.map((s) => ({
    id: s.seller.id,
    name: s.seller.name,
    channel: s.seller.channel,
    editable: s.editable,
  }));
  return { m, t, grid };
}
const byName = (grid: { id: string; name: string }[], first: string) =>
  grid.find((s) => s.name.startsWith(first))!;

describe("1. grade de metas segue a ordem da tela", () => {
  it("colar 3 linhas a partir de Karen (Ativa) preenche Karen, Nicolas Lima e Olívia Sales", async () => {
    const { grid } = await magFilialGrid();
    const karen = byName(grid, "Karen Rocha");
    const plan = planPaste(grid, karen.id, 1, [["100"], ["200"], ["300"]], LEVELS);
    const names = plan.cells.map((c) => grid.find((s) => s.id === c.sellerId)!.name);
    expect(names).toEqual(["Karen Rocha", "Nicolas Lima", "Olívia Sales"]);
    expect(plan.cells.every((c) => c.level === "ACTIVE")).toBe(true);
    expect(plan.applied).toBe(3);
    expect(plan.ignored).toBe(0);
  });
  it("Enter em Karen vai para Nicolas Lima", async () => {
    const { grid } = await magFilialGrid();
    const next = nextEditable(grid, byName(grid, "Karen Rocha").id, 1);
    expect(grid.find((s) => s.id === next)!.name).toBe("Nicolas Lima");
  });
  it("varejo vem antes de licitação e a colagem não passa para outro grupo", async () => {
    const { grid } = await magFilialGrid();
    const order = displayOrder(grid);
    const firstLic = order.findIndex((s) => s.channel === "licitacao");
    expect(order.slice(0, firstLic).every((s) => s.channel === "varejo")).toBe(true);
    const lastVarejo = order[firstLic - 1]!;
    const plan = planPaste(grid, lastVarejo.id, 0, [["1"], ["2"], ["3"]], LEVELS);
    expect(plan.applied).toBe(1);
    expect(plan.ignored).toBe(2);
  });
  it("linhas em vendedores sem permissão são ignoradas", () => {
    const grid = [
      { id: "a", channel: "varejo" as const, editable: true },
      { id: "b", channel: "varejo" as const, editable: false },
      { id: "c", channel: "varejo" as const, editable: true },
    ];
    const plan = planPaste(grid, "a", 1, [["1"], ["2"], ["3"], ["4"]], LEVELS);
    expect(plan.cells.map((c) => c.sellerId)).toEqual(["a", "c"]);
    expect(plan).toMatchObject({ applied: 2, ignored: 2 });
    expect(nextEditable(grid, "a", 1)).toBe("c");
  });
});

describe("2. trimestre/ano comparam só meses com meta", () => {
  it("4º trimestre da Mag Filial usa o % e o ritmo de novembro", async () => {
    const m = createMockFlightPlan({ latency: [0, 0], errorRate: 0 });
    const q = { companyId: "mag-filial", month: "2026-11" };
    const rows = await loadPeriodMonths(m.api, q, quarterOf("2026-11"));
    const nov = (await m.api.getPlan(q)).summary;
    const p = partialPeriod(rows);
    expect(p.missingTarget).toBe(2);
    expect(p.attainment).toBeCloseTo(nov.attainment!, 6);
    expect(p.requiredDailyPace).toBe(nov.requiredDailyPace);
    expect(p.requiredDailyPace).not.toBe(0);
    expect(p.attainment).not.toBeCloseTo(1.436, 3);
    expect(p.realizedTotal).toBeGreaterThan(p.realizedWithTarget);
    expect(missingTargetLabel(p)).toBe("Meta incompleta: 2 de 3 meses sem meta");
  });
  it("trimestre sem nenhuma meta (Ergo) diz que não há meta, não que está incompleta", async () => {
    const m = createMockFlightPlan({ latency: [0, 0], errorRate: 0 });
    const q = { companyId: "ergooffice", month: "2026-11" };
    const p = partialPeriod(await loadPeriodMonths(m.api, q, quarterOf("2026-11")));
    expect(p.target).toBeNull();
    expect(p.attainment).toBeNull();
    expect(p.requiredDailyPace).toBeNull();
    expect(missingTargetLabel(p)).toBe("Sem meta: nenhum dos 3 meses tem meta");
  });
  it("1º trimestre usa só março", async () => {
    const m = createMockFlightPlan({ latency: [0, 0], errorRate: 0 });
    const q = { companyId: "mag-filial", month: "2026-03" };
    const rows = await loadPeriodMonths(m.api, q, quarterOf("2026-03"));
    const mar = (await m.api.getPlan(q)).summary;
    const p = partialPeriod(rows);
    expect(rows.filter((r) => r.target !== null).map((r) => r.month)).toEqual(["2026-03"]);
    expect(p.missingTarget).toBe(2);
    expect(p.attainment).toBeCloseTo(mar.attainment!, 6);
    expect(p.requiredDailyPace).toBe(mar.requiredDailyPace);
  });
  it("rótulo de dia útil fracionado segue o peso do sábado da empresa", () => {
    expect(workdaysLabel(7.66, 0.33)).toBe("7,66 dias úteis (sábado conta 1/3)");
    expect(workdaysLabel(7.66, 0.33, "restantes")).toBe(
      "7,66 dias úteis restantes (sábado conta 1/3)",
    );
    expect(workdaysLabel(5, 0.33)).toBe("5 dias úteis");
    expect(workdaysLabel(7.5, 0.5)).toBe("7,5 dias úteis (sábado conta 1/2)");
    expect(saturdayNote(0)).toBe("");
    expect(saturdayNote(1)).toBe("");
  });
  it("empresa com sábado 0 (Ergo) não tem dia útil fracionado", async () => {
    const m = createMockFlightPlan({ latency: [0, 0], errorRate: 0 });
    const s = (await m.api.getPlan({ companyId: "ergooffice", month: "2026-11" })).summary;
    expect(Number.isInteger(s.workdaysTotal)).toBe(true);
    expect(workdaysLabel(s.workdaysTotal, 0)).not.toContain("sábado");
  });
  it("ano: a sobra dos meses encerrados entra no ritmo da meta acumulada", async () => {
    const m = createMockFlightPlan({ latency: [0, 0], errorRate: 0 });
    const q = { companyId: "mag-filial", month: "2026-11" };
    const p = partialPeriod(await loadPeriodMonths(m.api, q, yearOf("2026-11")));
    const nov = (await m.api.getPlan(q)).summary;
    expect(p.missingTarget).toBe(4);
    expect(p.requiredDailyPace).toBeCloseTo(
      (p.target! - p.realizedWithTarget) / p.workdaysRemaining,
      1,
    );
    // Julho a setembro passaram da meta: o ritmo acumulado do ano fica abaixo do ritmo do mês.
    expect(p.requiredDailyPace!).toBeLessThan(nov.requiredDailyPace!);
  });
});

describe("3. Não distribuído vem da API", () => {
  it("Gestor da Mag Filial vê R$ 20.000 a distribuir", async () => {
    const { t } = await magFilialGrid("GESTOR");
    const companyActive = t.company.reduce<number | null>(
      (a, c) => (c.targets.ACTIVE === null ? a : (a ?? 0) + c.targets.ACTIVE),
      null,
    );
    expect(adjustedUndistributed(t.undistributed, "ACTIVE", companyActive, companyActive, 0)).toBe(
      20_000,
    );
  });
  it("ajusta só pelas alterações não salvas", () => {
    const api = { BASE: null, ACTIVE: 20_000, CHALLENGE: 0 };
    expect(adjustedUndistributed(api, "ACTIVE", 500_000, 500_000, 5_000)).toBe(15_000);
    expect(adjustedUndistributed(api, "ACTIVE", 500_000, 510_000, 0)).toBe(30_000);
    expect(adjustedUndistributed(api, "ACTIVE", 500_000, null, 0)).toBeNull();
  });
});
