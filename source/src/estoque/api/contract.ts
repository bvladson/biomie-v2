// src/estoque/api/contract.ts
export type Curve = "A" | "B" | "C" | "D" | "U"; // U = sem curva (sem saldo e sem venda, ou ainda não calculada)
export type ClassifiedCurve = Exclude<Curve, "U">;
export type CompanyFilter = string | "all"; // id da empresa ou todas as que o usuário acessa
/** Janela da curva automática (faturamento da página Produtos), até a data de referência. */
export type CurveWindow = "30d" | "90d" | "180d" | "12m";
export type CurveSource = "auto" | "manual";
/** Sem venda na janela, mas sem histórico para afirmar: vendas começam depois ('sales') ou o produto é mais novo ('product'). */
export type IncompleteReason = "sales" | "product";
export type AgingBand = "30" | "90" | "180" | "365";

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
  // Curva automática (migração 0043)
  curveSource?: CurveSource | null | undefined; // null = ainda não calculada
  curveReason?: string | null | undefined; // justificativa da curva manual
  curveSetAt?: string | null | undefined;
  curveSetBy?: string | null | undefined;
  windowRevenue?: number | null | undefined; // faturamento na janela; null sem viewCost
  windowShare?: number | null | undefined; // participação no faturamento da empresa (0–1)
  productQty?: number | undefined; // saldo do produto somando os locais
  lastSale?: string | null | undefined; // última venda no histórico disponível (até 12 meses)
  daysWithoutSale?: number | null | undefined;
  salesFrom?: string | null | undefined; // início do histórico de vendas do BIOMIE
  idleSince?: string | null | undefined; // desde quando não vende (última venda, chegada ou início do histórico)
  lastEntry?: string | null | undefined; // última entrada (movimentações do Omie)
  lastEntryOperation?: string | null | undefined; // 21 compra, 22 importação, 00 ajuste...
  firstEntry?: string | null | undefined;
  registeredAt?: string | null | undefined; // inclusão no cadastro do Omie
  arrivedOn?: string | null | undefined; // chegada considerada para "produto novo"
  isNew?: boolean | undefined;
  incompleteHistory?: IncompleteReason | null | undefined;
  soldElsewhere?: { companyName: string; lastSale: string | null } | null | undefined;
  locations?: number | undefined; // na visão por produto
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
  window?: CurveWindow | undefined; // padrão: a da configuração (12 meses)
  view?: "position" | "product" | undefined; // produto = todos os locais somados
  onlyNew?: boolean | undefined;
  onlyIncomplete?: boolean | undefined;
  soldElsewhere?: boolean | undefined;
  onlyManual?: boolean | undefined;
  onlyConfirmed?: boolean | undefined; // saldo positivo, sem venda na janela, histórico suficiente, não é novo
  minDaysWithoutSale?: 30 | 90 | 180 | 365 | undefined; // saldo positivo e sem venda há N dias ou mais
  sortBy?:
    | "costValue"
    | "physicalQty"
    | "name"
    | "sku"
    | "lastSale"
    | "daysWithoutSale"
    | "windowRevenue"
    | undefined;
  sortDir?: "asc" | "desc" | undefined;
  page: number; // 0 = primeira; 100 linhas por página
}

export interface CurveSummary {
  curve: Curve;
  positions: number;
  products?: number | undefined;
  units: number;
  costValue: number | null;
  share: number | null; // % do valor a custo total
}

/** Situação do cálculo da curva automática de uma empresa. */
export interface CurveRun {
  companyId: string;
  companyName: string;
  status: "ok" | "skipped" | "failed" | "missing";
  computedAt: string | null; // último cálculo válido (o que a tela mostra)
  asOf: string | null; // data de referência das vendas
  salesFrom: string | null; // início do histórico de vendas do BIOMIE
  windowStart: string | null;
  incompleteHistory: boolean; // a janela começa antes do histórico de vendas
  reason: string | null; // por que o último cálculo foi adiado ou falhou
}

/** Curva D aberta: novo, histórico incompleto e sem venda confirmada (exclusivos). */
export interface DAnalysis {
  products: number;
  costValue: number | null;
  newProducts: number;
  newCostValue: number | null;
  incompleteProducts: number;
  incompleteCostValue: number | null;
  confirmedProducts: number;
  confirmedCostValue: number | null;
  elsewhereProducts: number; // dentre os D, com a mesma SKU vendida por outra empresa do grupo
  elsewhereCostValue: number | null;
}

/** Tempo sem venda dos produtos com saldo (independente da janela): faixas exclusivas. */
export interface AgingSummary {
  band: AgingBand; // 30 = 30–89 dias, 90 = 90–179, 180 = 180–364, 365 = 365 ou mais
  products: number;
  costValue: number | null;
  newProducts: number;
  incompleteProducts: number; // nunca venderam num histórico mais curto que 12 meses
}

export interface StockOverview {
  window?: CurveWindow | undefined;
  readings: StockReading[];
  curves?: CurveRun[] | undefined;
  dAnalysis?: DAnalysis | undefined;
  aging?: AgingSummary[] | undefined;
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
    manualCurves?: number | undefined; // produtos com curva manual
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
  overview(companyId: CompanyFilter, window?: CurveWindow): Promise<StockOverview>;
  positions(query: PositionQuery): Promise<{ rows: StockPosition[]; total: number }>;
  filterOptions(
    companyId: CompanyFilter,
  ): Promise<{ locations: { code: string; name: string | null }[]; families: string[] }>;
  /** A–D = manual (justificativa obrigatória, 10 a 300 caracteres); AUTO volta para a automática. */
  setCurve(input: {
    positionIds: string[];
    curve: ClassifiedCurve | "AUTO";
    reason?: string | undefined;
  }): Promise<{ updated: number }>;
  simulationBase(
    companyId: CompanyFilter,
    window?: CurveWindow,
  ): Promise<{ items: SimulationItem[]; readAt: string | null }>;
  listScenarios(): Promise<SavedScenario[]>;
  saveScenario(
    input: ScenarioInput & { name: string; id?: string | undefined },
  ): Promise<SavedScenario>;
  deleteScenario(id: string): Promise<void>;
  exportCsv(
    input:
      | { kind: "positions"; query: Omit<PositionQuery, "page"> }
      | {
          kind: "simulation";
          companyId: CompanyFilter;
          scenario: ScenarioInput;
          window?: CurveWindow | undefined;
        },
  ): Promise<{ fileName: string; csv: string }>;
  requestRefresh(
    companyId: string,
  ): Promise<{ queued: boolean; nextAllowedAt: string | null; inProgress?: boolean | undefined }>;
}
