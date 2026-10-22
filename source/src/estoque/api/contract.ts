// src/estoque/api/contract.ts
export type Curve = "A" | "B" | "C" | "D" | "U"; // U = sem curva
export type ClassifiedCurve = Exclude<Curve, "U">;
export type CompanyFilter = string | "all"; // id da empresa ou todas as que o usuário acessa

export interface StockCapabilities {
  viewCost: boolean; // CMC, valor a custo e simulação
  classify: boolean; // mudar curva
  saveScenarios: boolean; // salvar e excluir cenários
  export: boolean; // CSV
  refresh: boolean; // pedir nova leitura ao worker
}

export interface StockReading {
  companyId: string;
  companyName: string;
  readAt: string | null; // última leitura completa (ISO); null = nunca leu
  positions: number;
  status: "ok" | "stale" | "missing" | "failed"; // stale = mais de 6 h
  inProgress?: boolean | undefined; // leitura na fila ou em andamento
  lastError?: string | null | undefined; // motivo da última falha (só para quem pode pedir leitura)
}

export interface StockPosition {
  id: string; // estável: empresa + produto + local
  companyId: string;
  companyName: string;
  productId: string | null; // produto do BIOMIE (/produtos/:id)
  omieProductId: string;
  sku: string;
  name: string;
  family: string | null;
  locationCode: string;
  locationName: string | null;
  curve: Curve;
  physicalQty: number; // pode ser negativo
  reservedQty: number;
  pendingQty: number; // em pedidos de venda
  unitCost: number | null; // CMC; null sem viewCost
  costValue: number | null; // physicalQty × unitCost; null sem viewCost
  salePrice: number | null; // 0 = não informado no Omie; null sem viewCost
  minQty?: number | null | undefined; // estoque mínimo cadastrado no Omie
}

export interface PositionQuery {
  companyId: CompanyFilter;
  search?: string | undefined;
  curve?: Curve | "all" | undefined;
  locationCode?: string | undefined;
  family?: string | undefined;
  onlyNegative?: boolean | undefined;
  hideZero?: boolean | undefined; // esconde posições sem físico, reservado e pendente
  belowMin?: boolean | undefined; // só posições abaixo do estoque mínimo
  productId?: string | undefined;
  sortBy?: "costValue" | "physicalQty" | "name" | "sku" | undefined;
  sortDir?: "asc" | "desc" | undefined;
  page: number; // 0 = primeira; 100 linhas por página
}

export interface CurveSummary {
  curve: Curve;
  positions: number;
  units: number;
  costValue: number | null;
  share: number | null; // % do valor a custo total
}

export interface StockOverview {
  readings: StockReading[];
  totals: {
    positions: number;
    units: number;
    costValue: number | null;
    reservedQty: number;
    pendingQty: number;
    negativePositions: number;
    unclassifiedPositions: number;
    unclassifiedCostValue: number | null;
    positionsWithStock?: number | undefined; // com físico, reservado ou pendente diferente de zero
    belowMinPositions?: number | undefined; // abaixo do estoque mínimo do Omie
  };
  byCurve: CurveSummary[]; // sempre A, B, C, D e U, nesta ordem
  byCompany: {
    companyId: string;
    companyName: string;
    positions: number;
    costValue: number | null;
  }[];
}

export interface SimulationItem {
  id: string;
  sku: string;
  name: string;
  curve: Curve;
  qty: number;
  cost: number;
  price: number;
  companyName?: string | undefined; // para o CSV quando o filtro é "todas as empresas"
  locationName?: string | undefined;
}
export interface ScenarioInput {
  cuts: Record<ClassifiedCurve, number>;
  discount: number;
} // 0–100 e 0–70, inteiros
export interface SavedScenario extends ScenarioInput {
  id: string;
  name: string;
  updatedAt: string;
} // nome até 60

export interface StockApiError {
  code: "forbidden" | "invalid" | "busy" | "unavailable";
  message: string;
} // mensagem pronta, em pt-BR

export interface StockApi {
  capabilities(): Promise<StockCapabilities>;
  overview(companyId: CompanyFilter): Promise<StockOverview>;
  positions(query: PositionQuery): Promise<{ rows: StockPosition[]; total: number }>;
  filterOptions(
    companyId: CompanyFilter,
  ): Promise<{ locations: { code: string; name: string | null }[]; families: string[] }>;
  setCurve(input: { positionIds: string[]; curve: Curve }): Promise<{ updated: number }>;
  simulationBase(
    companyId: CompanyFilter,
  ): Promise<{ items: SimulationItem[]; readAt: string | null }>;
  listScenarios(): Promise<SavedScenario[]>;
  saveScenario(
    input: ScenarioInput & { name: string; id?: string | undefined },
  ): Promise<SavedScenario>;
  deleteScenario(id: string): Promise<void>;
  exportCsv(
    input:
      | { kind: "positions"; query: Omit<PositionQuery, "page"> }
      | { kind: "simulation"; companyId: CompanyFilter; scenario: ScenarioInput },
  ): Promise<{ fileName: string; csv: string }>;
  requestRefresh(
    companyId: string,
  ): Promise<{ queued: boolean; nextAllowedAt: string | null; inProgress?: boolean | undefined }>;
}
