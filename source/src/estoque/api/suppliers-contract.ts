/**
 * Fornecedores e prazos de entrega (migração 0048). O fornecedor é o cadastro do BIOMIE importado do Omie
 * (o código é o do Omie, de cada empresa); os vínculos produto × fornecedor vêm do Omie (Produto x
 * Fornecedor) ou de Compras; o prazo é informado no BIOMIE por Compras ou pelo Super admin, em dias corridos,
 * do produto com aquele fornecedor ou o padrão do fornecedor. Toda alteração tem observação e histórico.
 */
import type { CompanyFilter, Curve } from "./contract";

/** 'teste' só existe na homologação (prazo configurado na simulação). */
export type LeadTimeStatus = "confirmado" | "teste";

export interface LeadTime {
  leadTimeDays: number;
  minLot: number | null;
  status: LeadTimeStatus;
  note: string;
  updatedAt: string;
  updatedBy?: string | null | undefined; // só para Compras e Super admin
}

export type SupplierStatusFilter = "all" | "sem_prazo" | "com_prazo" | "teste" | "com_estoque";

export interface SupplierListRow {
  supplierId: string;
  name: string;
  city: string | null;
  state: string | null;
  inOmie: boolean; // veio na última importação do Omie
  products: number; // produtos vinculados
  productsWithStock: number;
  leadTimeDays: number | null; // prazo padrão do fornecedor
  leadTimeStatus: LeadTimeStatus | null;
  productLeadTimes: number; // produtos com prazo próprio
  hasTestLeadTimes: boolean;
  preferredFor: number; // produtos em que é o fornecedor principal
  updatedAt: string | null;
}

export interface SupplierImportJob {
  status: "queued" | "running" | "complete" | "failed";
  trigger: "schedule" | "manual" | "ops";
  createdAt: string;
  finishedAt: string | null;
  pagesDone: number;
  pagesTotal: number | null;
  suppliers: number;
  links: number;
  linksRemoved: number | null;
  error?: string | null | undefined; // só para quem pode alterar
}

export interface SupplierSummary {
  suppliers: number;
  links: number;
  manualLinks: number;
  productsWithStock: number;
  productsWithStockLinked: number;
  productsWithStockConfirmed: number; // com prazo confirmado por algum fornecedor vinculado
  testLeadTimes: number;
  testLeadTimesOn: boolean;
  importEnabled: boolean;
  lastImportAt: string | null;
  lastJob: SupplierImportJob | null;
}

export interface SupplierList {
  rows: SupplierListRow[];
  total: number;
  summary: SupplierSummary;
  canEdit: boolean;
  canImport: boolean;
}

export interface SupplierProduct {
  omieProductId: string;
  productId: string | null;
  sku: string | null;
  name: string | null;
  supplierCode: string | null; // código do produto como o fornecedor usa
  inOmie: boolean;
  manual: boolean;
  qty: number | null;
  curve: Curve;
  otherSuppliers: number;
  leadTime: Omit<LeadTime, "updatedBy"> | null; // prazo próprio do produto com este fornecedor
  preferred: "este" | "outro" | null; // fornecedor principal do produto
  preferredName: string | null;
}

/** Valores antes/depois de uma alteração (prazo, lote, status, observação, fornecedor, política). */
export type ChangeValues = Record<string, string | number | boolean | null>;

export interface SupplierChange {
  kind: "prazo" | "fornecedor_principal" | "vinculo" | "politica";
  change: "create" | "update" | "remove";
  omieProductId: string | null;
  productName: string | null;
  before: ChangeValues | null;
  after: ChangeValues | null;
  note: string | null;
  at: string;
  by: string;
}

export interface SupplierDetail {
  supplierId: string;
  name: string;
  legalName: string | null;
  city: string | null;
  state: string | null;
  inOmie: boolean;
  seenAt: string | null;
  canEdit: boolean;
  testLeadTimesOn: boolean;
  defaultLeadTime: LeadTime | null;
  products: SupplierProduct[];
  orphanLeadTimes: {
    omieProductId: string;
    sku: string | null;
    name: string | null;
    leadTimeDays: number;
    status: LeadTimeStatus;
    updatedAt: string;
  }[];
  history: SupplierChange[] | null; // null para quem não pode alterar
}

export interface ProductSupplier {
  supplierId: string;
  name: string;
  supplierCode: string | null;
  inOmie: boolean;
  manual: boolean;
  isPreferred: boolean;
  leadTimeDays: number | null; // efetivo: o do produto ou o padrão do fornecedor
  leadTimeSource: "produto" | "fornecedor" | null;
  leadTimeStatus: LeadTimeStatus | null;
  minLot: number | null;
  note: string | null;
  updatedAt: string | null;
}

export interface ProductSuppliers {
  omieProductId: string;
  canEdit: boolean;
  testLeadTimesOn: boolean;
  preferred: {
    supplierId: string;
    name: string;
    note: string;
    updatedAt: string;
    updatedBy?: string | null | undefined;
  } | null;
  suppliers: ProductSupplier[];
}

export interface CustomerMatch {
  supplierId: string;
  name: string;
  city: string | null;
  state: string | null;
  isSupplier: boolean;
}

/** Nível de serviço por curva A/B/C/D de 12 meses; U = produto sem curva. */
export type ServiceLevelsByCurve = Record<"A" | "B" | "C" | "D" | "U", number>;

export interface ReplenishmentPolicy {
  reviewDays: number;
  serviceLevels: ServiceLevelsByCurve;
  maxCoverageDays: number | null;
  note: string;
  updatedAt: string;
  updatedBy?: string | null | undefined;
}

export interface ReplenishmentPolicies {
  canEdit: boolean;
  serviceLevels: number[];
  defaults: {
    reviewDays: number;
    serviceLevels: ServiceLevelsByCurve;
    maxCoverageDays: number | null;
  };
  testLeadTimesOn: boolean;
  companies: {
    companyId: string;
    companyName: string;
    policy: ReplenishmentPolicy | null; // null = padrões do BIOMIE
    confirmedLeadTimes: number;
    testLeadTimes: number;
  }[];
}

export interface SuppliersApi {
  list(query: {
    companyId: CompanyFilter;
    search?: string | undefined;
    status?: SupplierStatusFilter | undefined;
    page: number;
  }): Promise<SupplierList>;
  detail(companyId: string, supplierId: string): Promise<SupplierDetail>;
  ofProduct(companyId: string, omieProductId: string): Promise<ProductSuppliers>;
  /** omieProductId vazio = prazo padrão do fornecedor; values null = remover. */
  setLeadTime(input: {
    companyId: string;
    supplierId: string;
    omieProductId?: string | undefined;
    values: { leadTimeDays: number; minLot?: number | null | undefined } | null;
    note: string;
  }): Promise<{ saved?: boolean; removed?: boolean }>;
  setPreferred(input: {
    companyId: string;
    omieProductId: string;
    supplierId: string | null;
    note: string;
  }): Promise<{ saved?: boolean; removed?: boolean }>;
  setLink(input: {
    companyId: string;
    omieProductId: string;
    supplierId: string;
    linked: boolean;
    note: string;
  }): Promise<{ changed: boolean }>;
  search(companyId: string, text: string): Promise<CustomerMatch[]>;
  requestImport(
    companyId: string,
  ): Promise<{ queued: boolean; inProgress: boolean; nextAllowedAt: string | null }>;
  policies(companyId: CompanyFilter): Promise<ReplenishmentPolicies>;
  setPolicy(input: {
    companyId: string;
    values: {
      reviewDays: number;
      serviceLevels: ServiceLevelsByCurve;
      maxCoverageDays?: number | null | undefined;
    } | null;
    note: string;
  }): Promise<{ saved?: boolean; removed?: boolean }>;
}
