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
// ---------------------------------------------------------------- simulador inteligente (fase 5)

/** Descontos prontos (o campo continua aceitando qualquer valor inteiro de 0 a 70%). */
export const DISCOUNT_PRESETS = [5, 10, 15, 20, 30] as const;

/**
 * Base do desconto, sempre explícita: o preço de venda cadastrado no Omie ou o preço médio vendido em
 * 12 meses (faturamento ÷ unidades, da análise da inteligência). Sem preço na base escolhida, o item
 * fica sem receita (conta em "sem preço"), nunca com o preço da outra base.
 */
export type PriceBasis = "omie" | "media12m";

/** "empresa:produto" a partir do id da posição ("empresa:produto:local"). */
export const productKey = (id: string) => id.split(":").slice(0, 2).join(":");

export function withPriceBasis(
  items: SimulationItem[],
  basis: PriceBasis,
  avgPrices: Map<string, number>,
): SimulationItem[] {
  if (basis === "omie") return items;
  return items.map((i) => ({ ...i, price: avgPrices.get(productKey(i.id)) ?? 0 }));
}

export interface BelowMarginItem {
  id: string;
  sku: string;
  name: string;
  curve: Curve;
  companyName?: string | undefined;
  cost: number;
  refPrice: number;
  price: number;
  marginPct: number;
  sold: number;
}

export interface CommercialResult {
  /** Receita se todo o saldo positivo com preço fosse vendido no preço simulado (não é venda garantida). */
  fullSaleRevenue: number;
  /** Custo do estoque analisado (saldo positivo). */
  analyzedCost: number;
  /** Receita do cenário − custo das unidades que saem, só nos itens com preço. */
  grossResult: number;
  /** Resultado bruto ÷ receita do cenário (itens com preço); null sem receita. */
  marginPct: number | null;
  /** Quanto se deixa de receber nas unidades que saem, em relação ao preço de referência. */
  discountAmount: number;
  belowMargin: BelowMarginItem[];
  belowMarginCount: number;
}

/**
 * Indicadores comerciais do cenário: os mesmos cortes e desconto de simulate(), a mesma conta de
 * saída. A quantidade vendida não muda com o desconto (não há histórico que sustente esse efeito).
 */
export function commercial(
  items: SimulationItem[],
  scenario: ScenarioInput,
  minMarginPct: number,
): CommercialResult {
  const { rows } = simulate(items, scenario);
  const factor = 1 - scenario.discount / 100;
  let fullSaleRevenue = 0,
    analyzedCost = 0,
    grossResult = 0,
    revenue = 0,
    discountAmount = 0;
  const below: BelowMarginItem[] = [];
  for (const r of rows) {
    if (r.qty > 0) {
      analyzedCost += r.qty * r.cost;
      if (r.price > 0) fullSaleRevenue += r.qty * r.price * factor;
    }
    if (r.sold <= 0 || r.price <= 0) continue;
    revenue += r.revenue;
    grossResult += r.revenue - r.removed;
    discountAmount += r.sold * r.price - r.revenue;
    const price = r.price * factor;
    const marginPct = ((price - r.cost) / price) * 100;
    if (marginPct < minMarginPct)
      below.push({
        id: r.id,
        sku: r.sku,
        name: r.name,
        curve: r.curve,
        companyName: r.companyName,
        cost: r.cost,
        refPrice: r.price,
        price,
        marginPct,
        sold: r.sold,
      });
  }
  below.sort((a, b) => a.marginPct - b.marginPct || a.sku.localeCompare(b.sku));
  return {
    fullSaleRevenue,
    analyzedCost,
    grossResult,
    marginPct: revenue > 0 ? (grossResult / revenue) * 100 : null,
    discountAmount,
    belowMargin: below.slice(0, 50),
    belowMarginCount: below.length,
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
