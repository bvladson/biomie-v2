import { describe, expect, it } from "vitest";
import type { Curve } from "../api/contract";
import type { CurveCapital, IntelMetrics, IntelOverview, IntelPareto } from "../api/intel-contract";
import type { IntelProductRow } from "../api/intel-contract";
import {
  BAND_ORDER,
  bandsAbove,
  coverageText,
  curveDistribution,
  days,
  evidence,
  evolutionRows,
  intelCsv,
  niceTicks,
  paretoChart,
  radarRows,
} from "./intel";

const byCurve: Record<Curve, CurveCapital> = {
  A: { products: 2, capital: 100, unknownCost: 0 },
  B: { products: 1, capital: 50, unknownCost: 0 },
  C: { products: 0, capital: 0, unknownCost: 0 },
  D: { products: 3, capital: 50, unknownCost: 1 },
  U: { products: 0, capital: 0, unknownCost: 0 },
};

const metrics = (over: Partial<IntelMetrics> = {}): IntelMetrics => ({
  stock: {
    qty: 10,
    available: 10,
    reserved: 0,
    pending: 0,
    minQty: 0,
    locations: 1,
    negativePositions: 0,
  },
  sales: {
    d30: { units: 1, invoices: 1, coveredDays: 30 },
    d60: { units: 1, invoices: 1, coveredDays: 60 },
    d90: { units: 9, invoices: 3, coveredDays: 90 },
    d180: { units: 9, invoices: 3, coveredDays: 180 },
    d365: { units: 9, invoices: 3, coveredDays: 296 },
  },
  velocityDaily: 0.1,
  velocityBasis: "90d",
  coverageDays: 100,
  turnoverAnnual: 1.11,
  trend60Pct: -50,
  returns365: { units: 0, events: 0 },
  lastSale: "2026-10-10",
  daysWithoutSale: 13,
  idleSince: "2026-10-10",
  lastEntry: null,
  lastEntryOperation: null,
  lastExit: null,
  lastExitOperation: null,
  lastExitGroup: false,
  recentExit: false,
  arrivedOn: null,
  registeredAt: null,
  isNew: false,
  incompleteReason: "sales",
  elsewhereCompany: "Ergo Office",
  elsewhereLastSale: "2026-10-01",
  curve: {
    current: "C",
    source: "auto",
    previous: null,
    changedOn: null,
    worsened: false,
    share12m: 0.01,
  },
  salesMonthly: [],
  historyCoveredDays: 296,
  ...over,
});

describe("inteligência do estoque — formatos", () => {
  it("diferencia ausência de valor e sem consumo", () => {
    expect(days(null)).toBe("—");
    expect(days(1)).toBe("1 dia");
    expect(coverageText(null, 0)).toBe("sem consumo");
    expect(coverageText(null, null)).toBe("—");
    expect(coverageText(99.6)).toBe("100 dias");
  });

  it("distribui por curva em capital, produtos ou participação", () => {
    expect(curveDistribution(byCurve, "capital").map((r) => r.value)).toEqual([100, 50, 0, 50]);
    expect(curveDistribution(byCurve, "products").map((r) => r.value)).toEqual([2, 1, 0, 3]);
    expect(curveDistribution(byCurve, "share").map((r) => r.value)).toEqual([0.5, 0.25, 0, 0.25]);
    const noCost = {
      ...byCurve,
      A: { ...byCurve.A, capital: null },
      B: { ...byCurve.B, capital: null },
    };
    expect(curveDistribution(noCost, "capital")[0]!.value).toBeNull();
  });

  it("evolução: soma as curvas e não inventa total sem custo", () => {
    const evo: IntelOverview["evolution"] = [
      {
        day: "2026-10-23",
        capital: { A: 10, B: 5, C: 0, D: 85 },
        products: { A: 1, B: 1, C: 0, D: 4 },
      },
      { day: "2026-10-24", capital: null, products: { A: 2, D: 3 } },
    ];
    expect(evolutionRows(evo, "capital")[0]!.total).toBe(100);
    expect(evolutionRows(evo, "capital")[1]!.total).toBeNull();
    expect(evolutionRows(evo, "products")[1]!.total).toBe(5);
    expect(evolutionRows(evo, "products")[1]!.label).toBe("24/10");
  });

  it("radar com as sete faixas na ordem, mesmo vazias", () => {
    const rows = radarRows(
      [{ band: "365+", products: 2, capital: 10, newProducts: 0 }],
      "products",
    );
    expect(rows.map((r) => r.band)).toEqual(BAND_ORDER);
    expect(rows.find((r) => r.band === "365+")!.value).toBe(2);
    expect(rows.find((r) => r.band === "0-30")!.value).toBe(0);
  });

  it("Pareto: barras limitadas e contagem de todas as curvas", () => {
    const pareto: IntelPareto = {
      window: "12m",
      companyId: "c",
      total: 100,
      limits: [80, 95],
      rows: [
        [1, "1", "S1", "Mesa", 70, 0.7, 0.7, "A", null],
        [2, "2", "S2", "Cadeira", 20, 0.2, 0.9, "B", "A"],
        [3, "3", "S3", "Banco", 10, 0.1, 1, "C", null],
      ],
    };
    const chart = paretoChart(pareto, 2);
    expect(chart.bars.map((b) => b.cumulativePct)).toEqual([70, 90]);
    expect(chart.counts).toEqual({ A: 1, B: 1, C: 1 });
    expect(chart.rest).toEqual({ products: 1, revenue: 10 });
    expect(chart.bars[1]!.manual).toBe("A");
  });

  it("evidências citam os números gravados e os limites do histórico", () => {
    const lines = evidence("saudavel", metrics());
    expect(lines[0]).toContain("9 unidades vendidas em 296 dias");
    expect(lines.join(" ")).toContain("cobre 100 dias");
    expect(lines.join(" ")).toContain("-50% contra os 60 anteriores");
    expect(lines.join(" ")).toContain("ausência de venda não é confirmada");
    expect(lines.join(" ")).toContain("A mesma SKU vendeu em Ergo Office (01/10/2026)");
    const unknown = evidence(
      "historico_insuficiente",
      metrics({
        sales: { ...metrics().sales, d365: { units: null, invoices: null, coveredDays: 0 } },
        lastSale: null,
      }),
    );
    expect(unknown[0]).toContain("Sem histórico de vendas");
  });

  it("faixas acima de N dias batem com o filtro 'mais de N dias'", () => {
    expect(bandsAbove(30)).toEqual(["31-60", "61-90", "91-180", "181-365", "365+"]);
    expect(bandsAbove(180)).toEqual(["181-365", "365+"]);
    expect(bandsAbove(365)).toEqual(["365+"]);
  });

  it("CSV sem colunas de custo para quem não vê custo e sem zero inventado", () => {
    const row: IntelProductRow = {
      companyId: "c",
      companyName: "MAG Filial",
      omieProductId: "1",
      productId: null,
      sku: "=SKU",
      name: "Mesa",
      family: null,
      curve: "D",
      curveSource: "auto",
      curveWorsened: false,
      qty: 3,
      available: 3,
      capital: 60,
      unitCost: 20,
      lastSale: null,
      daysWithoutSale: 200,
      coverageDays: null,
      turnoverAnnual: null,
      trend60Pct: null,
      units365: null,
      revenue365: null,
      state: "sem_venda_janela",
      flags: ["custo_provisorio"],
      band: "181-365",
      priority: 61.5,
      priorityParts: null,
    };
    const full = intelCsv([row], true).split("\r\n");
    expect(full[0]).toContain('"Capital"');
    expect(full[1]).toContain('"60,00"');
    expect(full[1]).toContain(`"'=SKU"`);
    expect(full[1]).toContain('"Sem venda na janela"');
    expect(full[1]).toContain('"Custo provisório (até R$ 1)"');
    const restricted = intelCsv([row], false).split("\r\n");
    expect(restricted[0]).not.toContain("Capital");
    expect(restricted[0]).not.toContain("Faturamento");
    expect(restricted[1]).not.toContain("60,00");
    // Cobertura, giro e unidades desconhecidos ficam vazios, nunca zero.
    expect(restricted[1]).toContain('"181 a 365 dias";"";"";"";""');
  });

  it("eixo com marcas redondas", () => {
    expect(niceTicks(2_550_000)).toEqual([0, 1_000_000, 2_000_000, 3_000_000]);
    expect(niceTicks(898)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(1000)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0)).toEqual([0]);
  });
});
