import type {
  ClassifiedCurve,
  Curve,
  ScenarioInput,
  SimulationItem,
  StockPosition,
  StockOverview,
} from "../api/contract";
export const CURVES: ClassifiedCurve[] = ["A", "B", "C", "D"];
export const ALL_CURVES: Curve[] = [...CURVES, "U"];
export const PRESETS = {
  conservative: { name: "Conservador", cuts: { A: 0, B: 10, C: 25, D: 50 }, discount: 10 },
  balanced: { name: "Equilibrado", cuts: { A: 0, B: 20, C: 50, D: 80 }, discount: 20 },
  intensive: { name: "Intensivo", cuts: { A: 0, B: 35, C: 75, D: 100 }, discount: 30 },
} satisfies Record<string, ScenarioInput & { name: string }>;
export interface CurveResult {
  curve: Curve;
  current: number;
  removed: number;
  projected: number;
  sale: number;
  revenue: number;
  units: number;
  sold: number;
  skus: number;
  missingPrice: number;
}
export interface SimulationRow extends SimulationItem {
  sold: number;
  current: number;
  removed: number;
  projected: number;
  remaining: number;
  revenue: number;
}
export function validateScenario(s: ScenarioInput) {
  return (
    Number.isInteger(s.discount) &&
    s.discount >= 0 &&
    s.discount <= 70 &&
    CURVES.every((c) => Number.isInteger(s.cuts[c]) && s.cuts[c] >= 0 && s.cuts[c] <= 100)
  );
}
/** Exact item-mode port of supplied calculate(), including its floating point epsilon. */
export function simulate(items: SimulationItem[], scenario: ScenarioInput) {
  if (!validateScenario(scenario))
    throw {
      code: "invalid",
      message: "Cortes devem ser inteiros entre 0 e 100%; desconto entre 0 e 70%.",
    };
  const byCurve: Record<Curve, CurveResult> = {
    A: empty("A"),
    B: empty("B"),
    C: empty("C"),
    D: empty("D"),
    U: empty("U"),
  };
  const rows: SimulationRow[] = [];
  for (const item of items) {
    const c = byCurve[item.curve];
    const rate = item.curve === "U" ? 0 : scenario.cuts[item.curve];
    const sold = Math.floor((Math.max(0, item.qty) * rate) / 100 + 1e-9);
    const current = item.qty * item.cost,
      removed = sold * item.cost,
      revenue = sold * item.price * (1 - scenario.discount / 100);
    c.current += current;
    c.removed += removed;
    c.sale += item.qty * item.price;
    c.revenue += revenue;
    c.units += item.qty;
    c.sold += sold;
    c.skus++;
    if (sold > 0 && item.price === 0) c.missingPrice++;
    rows.push({
      ...item,
      sold,
      current,
      removed,
      projected: current - removed,
      remaining: item.qty - sold,
      revenue,
    });
  }
  const totals = {
    current: 0,
    removed: 0,
    projected: 0,
    revenue: 0,
    units: 0,
    sold: 0,
    skus: 0,
    missingPrice: 0,
    reduction: 0,
  };
  const keys = [
    "current",
    "removed",
    "projected",
    "revenue",
    "units",
    "sold",
    "skus",
    "missingPrice",
  ] as const;
  for (const c of Object.values(byCurve)) {
    c.projected = c.current - c.removed;
    for (const key of keys) totals[key] += c[key];
  }
  totals.reduction = totals.current > 0 ? (totals.removed / totals.current) * 100 : 0;
  return { byCurve, totals, rows };
}
function empty(curve: Curve): CurveResult {
  return {
    curve,
    current: 0,
    removed: 0,
    projected: 0,
    sale: 0,
    revenue: 0,
    units: 0,
    sold: 0,
    skus: 0,
    missingPrice: 0,
  };
}
/** Charts exclude negatives without removing them from the accounting totals. */
export function chartProjection(items: SimulationItem[], scenario: ScenarioInput) {
  const positive = simulate(
    items.filter((i) => i.qty >= 0),
    scenario,
  );
  const excluded = items.filter((i) => i.qty < 0);
  return {
    data: ALL_CURVES.map((c) => ({
      curve: c === "U" ? "Sem curva" : c,
      current: positive.byCurve[c].current,
      projected: positive.byCurve[c].projected,
    })),
    excludedCount: excluded.length,
    excludedValue: excluded.reduce((s, i) => s + i.qty * i.cost, 0),
  };
}
/** Posição com alguma quantidade (física, reservada ou pendente). */
export const hasStock = (p: StockPosition) =>
  p.physicalQty !== 0 || p.reservedQty !== 0 || p.pendingQty !== 0;
/** Abaixo do estoque mínimo cadastrado no Omie (sem mínimo, nunca). */
export const belowMin = (p: StockPosition) =>
  typeof p.minQty === "number" && p.minQty > 0 && p.physicalQty < p.minQty;

export function summarize(
  positions: StockPosition[],
  viewCost: boolean,
): Omit<StockOverview, "readings"> {
  const cost = positions.reduce((s, p) => s + (p.costValue ?? 0), 0);
  const byCurve = ALL_CURVES.map((curve) => {
    const group = positions.filter((p) => p.curve === curve),
      value = group.reduce((s, p) => s + (p.costValue ?? 0), 0);
    return {
      curve,
      positions: group.length,
      units: group.reduce((s, p) => s + p.physicalQty, 0),
      costValue: viewCost ? value : null,
      share: viewCost && cost > 0 ? (value / cost) * 100 : null,
    };
  });
  const companyIds = [...new Set(positions.map((p) => p.companyId))];
  return {
    totals: {
      positions: positions.length,
      units: positions.reduce((s, p) => s + p.physicalQty, 0),
      costValue: viewCost ? cost : null,
      reservedQty: positions.reduce((s, p) => s + p.reservedQty, 0),
      pendingQty: positions.reduce((s, p) => s + p.pendingQty, 0),
      negativePositions: positions.filter((p) => p.physicalQty < 0).length,
      unclassifiedPositions: positions.filter((p) => p.curve === "U").length,
      unclassifiedCostValue: viewCost ? (byCurve[4]?.costValue ?? 0) : null,
      positionsWithStock: positions.filter(hasStock).length,
      belowMinPositions: positions.filter(belowMin).length,
    },
    byCurve,
    byCompany: companyIds.map((companyId) => {
      const group = positions.filter((p) => p.companyId === companyId);
      return {
        companyId,
        companyName: group[0]?.companyName ?? companyId,
        positions: group.length,
        costValue: viewCost ? group.reduce((s, p) => s + (p.costValue ?? 0), 0) : null,
      };
    }),
  };
}
