import { describe, expect, it } from "vitest";
import type { IntelForecast, ReplenishmentRow } from "../api/intel-contract";
import {
  evidenceValue,
  forecastRange,
  forecastRows,
  movementWeeks,
  recLabel,
  replenishmentCsv,
} from "./intel-insights";

const forecast = (over: Partial<IntelForecast> = {}): IntelForecast => ({
  status: "ok",
  message: null,
  version: "forecast-1.0.0",
  computedFor: "2026-10-23",
  weeks: 3,
  nonzeroWeeks: 3,
  trainFrom: "2026-10-03",
  trainTo: "2026-10-23",
  demandClass: "frequente",
  adi: 1,
  cv2: 0,
  seasonality: "nao_avaliavel",
  limitations: [],
  series: { weekEnd: "2026-10-23", actual: [1, 2, 3], fitted: [null, 1, 1.5] },
  weeklyRate: 2,
  ...over,
});

describe("inteligência fases 3–5 — formatos", () => {
  it("evidências com unidade, datas e ausência", () => {
    expect(
      evidenceValue({ key: "c", label: "Capital", value: 1234.5, unit: "R$", cost: true }),
    ).toMatch(/R\$\s?1\.234,50/);
    expect(evidenceValue({ key: "d", label: "Dias", value: 1, unit: "dias" })).toBe("1 dia");
    expect(evidenceValue({ key: "d", label: "Dias", value: 120, unit: "dias" })).toBe("120 dias");
    expect(evidenceValue({ key: "t", label: "Variação", value: -45.25, unit: "%" })).toBe("-45,3%");
    expect(evidenceValue({ key: "u", label: "Saldo", value: 3.5, unit: "un." })).toBe("3,5 un.");
    expect(evidenceValue({ key: "x", label: "Última venda", value: "2026-03-05" })).toBe(
      "05/03/2026",
    );
    expect(evidenceValue({ key: "x", label: "Curva", value: "A" })).toBe("A");
    expect(evidenceValue({ key: "x", label: "Nada", value: null })).toBe("—");
    expect(recLabel("nao_comprar")).toBe("Não comprar agora");
    expect(recLabel("tipo_novo")).toBe("tipo_novo");
  });

  it("faixa da previsão só quando existe", () => {
    expect(forecastRange({ units: 8.57 })).toBe("8,57 un.");
    expect(forecastRange({ units: 8, low: 3, high: 12 })).toBe("8 un. (faixa 3 a 12)");
  });
});

describe("inteligência fases 3–5 — gráficos", () => {
  it("previsão: semanas observadas alinhadas e 13 semanas à frente", () => {
    const rows = forecastRows(forecast());
    expect(rows).toHaveLength(3 + 13);
    expect(rows.map((r) => r.weekEnd).slice(0, 4)).toEqual([
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ]);
    expect(rows[2]).toEqual(expect.objectContaining({ actual: 3, fitted: 1.5, forecast: 3 }));
    expect(rows[3]).toEqual(expect.objectContaining({ actual: null, forecast: 2 }));
  });

  it("sem previsão aprovada, nada à frente (não inventa série)", () => {
    const rows = forecastRows(forecast({ status: "insuficiente" }));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.forecast === null)).toBe(true);
  });

  it("movimentações por semana e saldo estimado que fecha com o saldo atual", () => {
    const movements = {
      from: "2026-01-01",
      days: [
        ["2026-10-20", 10, null, 10, null], // compra de 10 na última semana
        ["2026-10-13", null, 4, null, 4], // venda de 4 na semana anterior
        ["2026-10-21", 6, 6, null, null], // transferência entre locais (soma zero)
      ] as [string, number | null, number | null, number | null, number | null][],
    };
    const { rows, stockConsistent } = movementWeeks(movements, "2026-10-23", 12, 3);
    expect(stockConsistent).toBe(true);
    expect(rows.map((r) => r.weekEnd)).toEqual(["2026-10-09", "2026-10-16", "2026-10-23"]);
    expect(rows.map((r) => r.stock)).toEqual([6, 2, 12]); // 12 − 10 = 2; 2 + 4 = 6
    expect(rows[2]).toEqual(expect.objectContaining({ purchases: 10, sales: 0, other: 12 }));
    expect(rows[1]).toEqual(expect.objectContaining({ sales: 4 }));
  });

  it("saldo estimado some quando não fecha ou quando as movimentações não cobrem o período", () => {
    const days = [["2026-10-20", null, 50, null, 50]] as [
      string,
      number | null,
      number | null,
      number | null,
      number | null,
    ][];
    // saldo atual 0 e saída de 50: antes da saída teria de ser 50 — possível; com entrada de 50, seria −50
    const impossible = movementWeeks(
      { from: "2026-01-01", days: [["2026-10-20", 50, null, 50, null]] },
      "2026-10-23",
      0,
      3,
    );
    expect(impossible.stockConsistent).toBe(false);
    expect(impossible.rows.every((r) => r.stock === null)).toBe(true);
    const short = movementWeeks({ from: "2026-10-15", days }, "2026-10-23", 0, 3);
    expect(short.stockConsistent).toBe(false);
  });
});

describe("inteligência fase 5 — CSV da reposição", () => {
  const row: ReplenishmentRow = {
    companyId: "c1",
    companyName: "MAG Filial",
    omieProductId: "10",
    sku: "SKU-1",
    name: "Cadeira",
    family: "Cadeiras",
    curve: "A",
    state: "risco_ruptura",
    available: 2,
    pending: 1,
    status: "comprar",
    qty: 20,
    costEstimate: 1000,
    leadTimeDays: 30,
    serviceLevel: 0.9,
    risk: "Falta estimada.",
    explanation: "Demanda prevista de 1 un./dia",
  };
  it("sem permissão de custo, sem a coluna de custo estimado", () => {
    const withCost = replenishmentCsv([row], true);
    const without = replenishmentCsv([row], false);
    expect(withCost.split("\n")[0]).toContain("Custo estimado");
    expect(without.split("\n")[0]).not.toContain("Custo estimado");
    expect(without).not.toContain("1000");
    expect(withCost).toContain("Comprar");
    expect(withCost).toContain("90%");
  });
});
