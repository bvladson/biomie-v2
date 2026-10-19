/**
 * Financeiro (receivables analytics) — canonical vocabulary shared by UI and
 * server. Status/balance rules live in SQL (`finance_title_facts`); derived
 * ratios live in `src/domain/metrics/compute.ts`.
 */
export const FINANCE_CAPABILITIES = [
  "finance.view_summary",
  "finance.view_titles",
  "finance.view_customer_details",
  "finance.view_overdue",
  "finance.export",
] as const;
export type FinanceCapability = (typeof FINANCE_CAPABILITIES)[number];

export const FINANCE_CAPABILITY_LABELS: Record<FinanceCapability, string> = {
  "finance.view_summary": "Resumo financeiro",
  "finance.view_titles": "Títulos",
  "finance.view_customer_details": "Financeiro do cliente",
  "finance.view_overdue": "Inadimplência",
  "finance.export": "Exportar financeiro",
};

/** Extra permissions grantable per user (beyond role defaults). */
export const GRANTABLE_PERMISSIONS = ["documents:view_full", ...FINANCE_CAPABILITIES] as const;
export type GrantablePermission = (typeof GRANTABLE_PERMISSIONS)[number];
export const GRANTABLE_LABELS: Record<GrantablePermission, string> = {
  "documents:view_full": "CPF/CNPJ completo",
  ...FINANCE_CAPABILITY_LABELS,
};

export const TITLE_STATUSES = ["OPEN", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"] as const;
export type TitleStatus = (typeof TITLE_STATUSES)[number];
export const TITLE_STATUS_LABELS: Record<TitleStatus, string> = {
  OPEN: "Em aberto",
  PARTIALLY_PAID: "Parcialmente pago",
  PAID: "Pago",
  OVERDUE: "Vencido",
  CANCELLED: "Cancelado",
};

export const AGING_BUCKETS = ["future", "d1_30", "d31_60", "d61_90", "d91_180", "d180p"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_LABELS: Record<AgingBucket, string> = {
  future: "A vencer",
  d1_30: "1–30 dias",
  d31_60: "31–60 dias",
  d61_90: "61–90 dias",
  d91_180: "91–180 dias",
  d180p: "180+ dias",
};

export interface AgingRow {
  bucket: AgingBucket;
  value: number | null;
  titles: number | null;
  customers: number | null;
}
