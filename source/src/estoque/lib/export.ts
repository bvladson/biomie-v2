/**
 * CSV do Estoque — a mesma montagem no servidor (exportação real) e nos dados de exemplo.
 * Separador ";", centavos com vírgula e proteção contra fórmula (csvCell), como no projeto
 * de origem. Sem permissão de custo, as colunas de custo não existem no arquivo.
 */
import type { ScenarioInput, SimulationItem, StockPosition } from "../api/contract";
import { csv, decimal } from "./format";
import { ALL_CURVES, simulate } from "./simulation";

const optional = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : decimal(value);

export function positionsCsv(rows: StockPosition[], viewCost: boolean): string {
  return csv([
    [
      "Empresa",
      "Produto",
      "SKU",
      "Família",
      "Local",
      "Curva",
      "Físico",
      "Reservado",
      "Pendente",
      "Mínimo",
      ...(viewCost ? ["CMC", "Valor a custo", "Preço de venda"] : []),
    ],
    ...rows.map((p) => [
      p.companyName,
      p.name,
      p.sku,
      p.family,
      p.locationName ?? p.locationCode,
      p.curve,
      decimal(p.physicalQty),
      decimal(p.reservedQty),
      decimal(p.pendingQty),
      optional(p.minQty),
      ...(viewCost
        ? [decimal(p.unitCost ?? 0), decimal(p.costValue ?? 0), decimal(p.salePrice ?? 0)]
        : []),
    ]),
  ]);
}

export function simulationCsv(items: SimulationItem[], scenario: ScenarioInput): string {
  const result = simulate(items, scenario);
  const withCompany = items.some((i) => i.companyName);
  return csv([
    ["CENÁRIO"],
    ["Saída A", "Saída B", "Saída C", "Saída D", "Desconto"],
    [
      `${scenario.cuts.A}%`,
      `${scenario.cuts.B}%`,
      `${scenario.cuts.C}%`,
      `${scenario.cuts.D}%`,
      `${scenario.discount}%`,
    ],
    [],
    ["RESUMO POR CURVA"],
    [
      "Curva",
      "Atual",
      "Redução",
      "Projetado",
      "Receita",
      "Unidades",
      "Saída",
      "Posições",
      "Sem preço",
    ],
    ...ALL_CURVES.map((c) => {
      const r = result.byCurve[c];
      return [
        c,
        decimal(r.current),
        decimal(r.removed),
        decimal(r.projected),
        decimal(r.revenue),
        decimal(r.units),
        r.sold,
        r.skus,
        r.missingPrice,
      ];
    }),
    [
      "Total",
      decimal(result.totals.current),
      decimal(result.totals.removed),
      decimal(result.totals.projected),
      decimal(result.totals.revenue),
      decimal(result.totals.units),
      result.totals.sold,
      result.totals.skus,
      result.totals.missingPrice,
    ],
    [],
    ["POR PRODUTO E LOCAL"],
    [
      ...(withCompany ? ["Empresa"] : []),
      "Posição",
      "SKU",
      "Produto",
      "Local",
      "Curva",
      "Físico",
      "Saída",
      "Restante",
      "Atual",
      "Redução",
      "Projetado",
      "Receita",
    ],
    ...result.rows.map((r) => [
      ...(withCompany ? [r.companyName ?? ""] : []),
      r.id,
      r.sku,
      r.name,
      r.locationName ?? "",
      r.curve,
      decimal(r.qty),
      r.sold,
      decimal(r.remaining),
      decimal(r.current),
      decimal(r.removed),
      decimal(r.projected),
      decimal(r.revenue),
    ]),
    [],
    ["Simulação sem novas compras, impostos, frete ou despesas; sem garantia de venda."],
    ...(result.totals.missingPrice ? [["Receita parcial: há saídas sem preço de venda."]] : []),
  ]);
}
