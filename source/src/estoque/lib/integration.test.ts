import { describe, expect, it } from "vitest";
import { toStockError } from "../api/server-client";
import type { SimulationItem, StockPosition } from "../api/contract";
import { positionsCsv, simulationCsv } from "./export";
import { canOpenStock } from "./hooks";
import { belowMin, hasStock, PRESETS } from "./simulation";

const position = (patch: Partial<StockPosition> = {}): StockPosition => ({
  id: "c:1:1",
  companyId: "c",
  companyName: "MAG FILIAL",
  productId: null,
  omieProductId: "1",
  sku: "=SKU",
  name: "Cadeira",
  family: null,
  locationCode: "1",
  locationName: "Depósito",
  curve: "A",
  physicalQty: 10,
  reservedQty: 0,
  pendingQty: 0,
  unitCost: 100,
  costValue: 1000,
  salePrice: 180,
  minQty: null,
  ...patch,
});

describe("integração do Estoque com o servidor", () => {
  it("traduz o erro do servidor para o contrato e esconde falhas técnicas", () => {
    expect(toStockError(new Error("forbidden::Seu perfil não tem acesso ao Estoque."))).toEqual({
      code: "forbidden",
      message: "Seu perfil não tem acesso ao Estoque.",
    });
    expect(toStockError(new Error("invalid::Selecione posições válidas e uma curva."))).toEqual({
      code: "invalid",
      message: "Selecione posições válidas e uma curva.",
    });
    for (const raw of [new Error("relation private.stock_positions does not exist"), "x", null]) {
      expect(toStockError(raw)).toEqual({
        code: "unavailable",
        message: "Não foi possível carregar o estoque. Tente de novo.",
      });
    }
  });

  it("libera a tela pelo banco ou para o Super admin (que entra pela URL)", () => {
    expect(canOpenStock({ roles: ["GESTOR"], features: ["stock"] })).toBe(true);
    expect(canOpenStock({ roles: ["GESTOR"], features: [] })).toBe(false);
    expect(canOpenStock({ roles: ["SUPER_ADMIN"], features: [] })).toBe(true);
    expect(canOpenStock({ roles: ["VIEWER"] })).toBe(false);
  });

  it("marca posições zeradas e abaixo do mínimo", () => {
    expect(hasStock(position({ physicalQty: 0 }))).toBe(false);
    expect(hasStock(position({ physicalQty: 0, pendingQty: 2 }))).toBe(true);
    expect(belowMin(position({ physicalQty: 3, minQty: 5 }))).toBe(true);
    expect(belowMin(position({ physicalQty: 3, minQty: null }))).toBe(false);
    expect(belowMin(position({ physicalQty: 3, minQty: 0 }))).toBe(false);
  });
});

describe("CSV do Estoque", () => {
  it("posições: sem custo, as colunas de custo não existem; fórmulas protegidas", () => {
    const withCost = positionsCsv([position({ minQty: 4 })], true).split("\r\n");
    expect(withCost[0]).toContain('"CMC"');
    expect(withCost[1]).toContain(`"'=SKU"`);
    expect(withCost[1]).toContain('"4,00"');
    const noCost = positionsCsv(
      [position({ unitCost: null, costValue: null, salePrice: null })],
      false,
    );
    expect(noCost).not.toContain("CMC");
    expect(noCost).not.toContain("Valor a custo");
  });

  it("simulação: cenário, resumo com total e linhas com empresa quando há mais de uma", () => {
    const items: SimulationItem[] = [
      {
        id: "a",
        sku: "1",
        name: "Cadeira",
        curve: "D",
        qty: 10,
        cost: 100,
        price: 0,
        companyName: "MAG",
        locationName: "Depósito",
      },
      {
        id: "b",
        sku: "2",
        name: "Mesa",
        curve: "U",
        qty: 5,
        cost: 50,
        price: 90,
        companyName: "UNI",
        locationName: "Showroom",
      },
    ];
    const lines = simulationCsv(items, PRESETS.intensive).split("\r\n");
    expect(lines).toContain('"0%";"35%";"75%";"100%";"30%"');
    const total = lines.find((l) => l.startsWith('"Total"'));
    expect(total).toBe('"Total";"1250,00";"1000,00";"250,00";"0,00";"15,00";"10";"2";"1"');
    expect(lines.some((l) => l.startsWith('"Empresa";"Posição"'))).toBe(true);
    expect(lines.at(-1)).toContain("Receita parcial");
    const single = simulationCsv(
      items.map(({ companyName: _c, ...i }) => i),
      PRESETS.intensive,
    );
    expect(single).not.toContain('"Empresa";"Posição"');
  });
});
