import { describe, expect, it } from "vitest";
import type { StockPosition } from "../api/contract";
import {
  exitLabel,
  incompleteLabel,
  isCurveWindow,
  lastSaleText,
  operationLabel,
  percent,
  shortDate,
} from "./curves";
import { positionsCsv } from "./export";

const base: StockPosition = {
  id: "c1:1001:1",
  companyId: "c1",
  companyName: "MAG Filial",
  productId: null,
  omieProductId: "1001",
  sku: "SKU-1001",
  name: "Mesa diretoria",
  family: "Mesas",
  locationCode: "1",
  locationName: "Depósito",
  curve: "D",
  physicalQty: 3,
  reservedQty: 0,
  pendingQty: 0,
  unitCost: 100,
  costValue: 300,
  salePrice: 250,
};

describe("curva automática na tela", () => {
  it("datas do banco viram DD/MM/AAAA sem fuso", () => {
    expect(shortDate("2026-01-01")).toBe("01/01/2026");
    expect(shortDate(null)).toBe("—");
    expect(isCurveWindow("12m")).toBe(true);
    expect(isCurveWindow("7d")).toBe(false);
  });

  it("última venda: data com dias, ou desde quando não vende", () => {
    expect(lastSaleText({ ...base, lastSale: "2026-09-12", daysWithoutSale: 40 })).toBe(
      "12/09/2026 · há 40 dias",
    );
    expect(lastSaleText({ ...base, lastSale: null, salesFrom: "2026-01-01" })).toBe(
      "Sem venda desde 01/01/2026 (início do histórico)",
    );
    expect(
      lastSaleText({
        ...base,
        lastSale: null,
        salesFrom: "2026-01-01",
        arrivedOn: "2026-10-02",
        idleSince: "2026-10-02",
        daysWithoutSale: 21,
      }),
    ).toBe("Sem venda desde a chegada (02/10/2026) · 21 dias");
  });

  it("histórico incompleto explica o motivo", () => {
    expect(incompleteLabel("sales", { ...base, salesFrom: "2026-01-01" })).toBe(
      "Histórico incompleto: vendas no BIOMIE desde 01/01/2026",
    );
    expect(incompleteLabel("product", { ...base, arrivedOn: "2026-06-15" })).toBe(
      "Histórico incompleto: produto chegou em 15/06/2026",
    );
    expect(incompleteLabel(null)).toBe("");
  });

  it("operações do Omie e participação em português", () => {
    expect(operationLabel("21")).toBe("Compra");
    expect(operationLabel("28")).toBe("Entrada da produção");
    expect(exitLabel("28")).toBe("Consumo na produção");
    expect(exitLabel("14")).toBe("Remessa");
    expect(exitLabel("11")).toBe("Venda");
    expect(exitLabel("11", true)).toBe("Venda para empresa do grupo");
    expect(exitLabel("28", true)).toBe("Consumo na produção");
    expect(operationLabel("99")).toBe("Operação 99");
    expect(percent(0.256)).toBe("25,6%");
  });

  it("CSV traz curva da janela, origem, justificativa e indicadores; custo só com permissão", () => {
    const row: StockPosition = {
      ...base,
      curve: "A",
      curveSource: "manual",
      curveReason: "Produto estratégico",
      windowRevenue: 700,
      windowShare: 0.7,
      lastSale: "2026-10-12",
      daysWithoutSale: 10,
      isNew: true,
      incompleteHistory: null,
      soldElsewhere: { companyName: "Expert", lastSale: "2026-10-01" },
      lastExit: "2026-10-20",
      lastExitOperation: "28",
      recentExit: true,
    };
    const withCost = positionsCsv([row], true, "90d").split("\r\n");
    expect(withCost[0]).toContain("Curva (90 dias)");
    expect(withCost[0]).toContain("Faturamento (90 dias)");
    expect(withCost[1]).toContain('"Manual"');
    expect(withCost[1]).toContain('"Produto estratégico"');
    expect(withCost[1]).toContain('"Expert (01/10/2026)"');
    expect(withCost[0]).toContain("Última saída");
    expect(withCost[1]).toContain('"Consumo na produção"');
    const noCost = positionsCsv([row], false).split("\r\n");
    expect(noCost[0]).not.toContain("Faturamento");
    expect(noCost[0]).not.toContain("CMC");
  });
});
