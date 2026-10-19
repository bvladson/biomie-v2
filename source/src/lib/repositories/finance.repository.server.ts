import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnalyticsQuery } from "@/domain/filters";
import type { AgingRow, FinanceCapability, TitleStatus } from "@/domain/finance";
import { overdueRate, receivableTicket, weightedAverageDays } from "@/domain/metrics/compute";

type Client = SupabaseClient<Database>;
const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v == null ? null : Number(v));

function friendly(error: { code?: string; message?: string }, what: string): Error {
  console.error(`${what} failed`, error);
  if (error.code === "42501")
    return new Error(
      error.message?.startsWith("Sem permissão") ? error.message : "Sem acesso a esta empresa.",
    );
  return new Error(`Não foi possível carregar ${what}.`);
}

/** Whole calendar month of the period (reference date is clamped in SQL to data_as_of). */
function monthRange(period: string) {
  const [y = 0, m = 1] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

function filterArgs(q: AnalyticsQuery) {
  return Object.fromEntries(
    Object.entries({
      p_channel: q.channel,
      p_branch: q.branch,
      p_seller: q.seller,
      p_state: q.state,
      p_city: q.city,
    }).filter(([, v]) => v !== undefined),
  );
}

const aging = (raw: unknown): AgingRow[] =>
  ((raw as Record<string, unknown>[]) ?? []).map((a) => ({
    bucket: a["bucket"] as AgingRow["bucket"],
    value: nn(a["value"]),
    titles: nn(a["titles"]),
    customers: nn(a["customers"]),
  }));

export interface FinanceSummaryDTO {
  ref: string;
  range: { start: string; end: string };
  capabilities: FinanceCapability[];
  overdueVisible: boolean;
  kpis: {
    receivable: number;
    receivableCount: number;
    received: number;
    receivedCount: number;
    open: number | null;
    openCount: number | null;
    overdue: number | null;
    overdueCount: number | null;
    dueFuture: number | null;
    customersOverdue: number | null;
    overdueRate: number | null;
    averageDaysToReceive: number | null;
    averageDelayDays: number | null;
    receivableTicket: number | null;
    cancelledCount: number;
  };
  aging: AgingRow[];
  timeline: { month: string; billed: number; received: number }[];
}

export async function getFinanceSummary(sb: Client, q: AnalyticsQuery): Promise<FinanceSummaryDTO> {
  const range = monthRange(q.period);
  const { data, error } = await sb.rpc("finance_summary", {
    p_company: q.company,
    p_start: range.start,
    p_end: range.end,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "o resumo financeiro");
  const d = data as Record<string, unknown>;
  const open = nn(d["open"]);
  const overdue = nn(d["overdue"]);
  const received = n(d["received"]);
  const receivable = n(d["receivable"]);
  return {
    ref: String(d["ref"]),
    range,
    capabilities: (d["capabilities"] as FinanceCapability[]) ?? [],
    overdueVisible: Boolean(d["overdueVisible"]),
    kpis: {
      receivable,
      receivableCount: n(d["receivableCount"]),
      received,
      receivedCount: n(d["receivedCount"]),
      open,
      openCount: nn(d["openCount"]),
      overdue,
      overdueCount: nn(d["overdueCount"]),
      dueFuture: nn(d["dueFuture"]),
      customersOverdue: nn(d["customersOverdue"]),
      overdueRate: overdueRate(overdue, open),
      averageDaysToReceive: weightedAverageDays(n(d["receivedDaysWeighted"]), received),
      averageDelayDays:
        d["receivedDelayWeighted"] == null
          ? null
          : weightedAverageDays(n(d["receivedDelayWeighted"]), received),
      receivableTicket: receivableTicket(receivable, n(d["receivableCount"])),
      cancelledCount: n(d["cancelledCount"]),
    },
    aging: aging(d["aging"]),
    timeline: ((d["timeline"] as Record<string, unknown>[]) ?? []).map((t) => ({
      month: String(t["month"]),
      billed: n(t["billed"]),
      received: n(t["received"]),
    })),
  };
}

export interface TitleRow {
  id: string;
  customerId: string | null;
  customer: string | null;
  sellerId: string | null;
  seller: string | null;
  invoiceId: string | null;
  document: string;
  installment: number;
  installments: number;
  issueDate: string;
  dueDate: string;
  settledDate: string | null;
  original: number;
  adjustments: number;
  paid: number;
  open: number;
  status: TitleStatus;
  daysLate: number | null;
}

const toTitle = (r: Record<string, unknown>): TitleRow => ({
  id: String(r["id"]),
  customerId: (r["customerId"] as string) ?? null,
  customer: (r["customer"] as string) ?? null,
  sellerId: (r["sellerId"] as string) ?? null,
  seller: (r["seller"] as string) ?? null,
  invoiceId: (r["invoiceId"] as string) ?? null,
  document: String(r["document"]),
  installment: n(r["installment"]),
  installments: n(r["installments"]),
  issueDate: String(r["issueDate"]),
  dueDate: String(r["dueDate"]),
  settledDate: (r["settledDate"] as string) ?? null,
  original: n(r["original"]),
  adjustments: n(r["adjustments"]),
  paid: n(r["paid"]),
  open: n(r["open"]),
  status: r["status"] as TitleStatus,
  daysLate: nn(r["daysLate"]),
});

export interface TitlesDTO {
  ref: string;
  overdueVisible: boolean;
  rows: TitleRow[];
}

export async function getFinanceTitles(
  sb: Client,
  q: AnalyticsQuery,
  customer?: string,
): Promise<TitlesDTO> {
  const range = monthRange(q.period);
  const { data, error } = await sb.rpc("finance_titles_list", {
    p_company: q.company,
    p_start: range.start,
    p_end: range.end,
    ...filterArgs(q),
    ...(customer ? { p_customer: customer } : {}),
  });
  if (error) throw friendly(error, "os títulos");
  const d = data as Record<string, unknown>;
  return {
    ref: String(d["ref"]),
    overdueVisible: Boolean(d["overdueVisible"]),
    rows: ((d["rows"] as Record<string, unknown>[]) ?? []).map(toTitle),
  };
}

export interface CustomerFinanceDTO {
  ref: string;
  overdueVisible: boolean;
  billed: number;
  titled: number;
  received: number;
  open: number | null;
  overdue: number | null;
  aging: AgingRow[];
  settlements: {
    date: string;
    amount: number;
    document: string;
    installment: number;
    dueDate: string | null;
    daysLate: number | null;
  }[];
  titles: TitleRow[];
}

export async function getCustomerFinance(
  sb: Client,
  company: string,
  customer: string,
): Promise<CustomerFinanceDTO> {
  const { data, error } = await sb.rpc("finance_customer", {
    p_company: company,
    p_customer: customer,
  });
  if (error) throw friendly(error, "o financeiro do cliente");
  const d = data as Record<string, unknown>;
  return {
    ref: String(d["ref"]),
    overdueVisible: Boolean(d["overdueVisible"]),
    billed: n(d["billed"]),
    titled: n(d["titled"]),
    received: n(d["received"]),
    open: nn(d["open"]),
    overdue: nn(d["overdue"]),
    aging: aging(d["aging"]),
    settlements: ((d["settlements"] as Record<string, unknown>[]) ?? []).map((s) => ({
      date: String(s["date"]),
      amount: n(s["amount"]),
      document: String(s["document"]),
      installment: n(s["installment"]),
      dueDate: (s["dueDate"] as string | null) ?? null,
      daysLate: nn(s["daysLate"]),
    })),
    titles: ((d["titles"] as Record<string, unknown>[]) ?? []).map(toTitle),
  };
}

export async function getMyFinanceCapabilities(
  sb: Client,
  userId: string,
): Promise<FinanceCapability[]> {
  const { data, error } = await sb.rpc("finance_capabilities", { _user: userId });
  if (error) throw friendly(error, "as permissões financeiras");
  return (data as FinanceCapability[]) ?? [];
}
