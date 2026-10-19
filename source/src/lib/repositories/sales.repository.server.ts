import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnalyticsQuery } from "@/domain/filters";
import {
  ALL_COMPARISONS,
  compare,
  comparisonRange,
  periodRange,
  type Comparison,
  type DateRange,
} from "@/domain/comparison";
import {
  attainment,
  averageTicket,
  averageUnitPrice,
  delta,
  recurringCustomers,
  share,
  trailingAverage,
} from "@/domain/metrics/compute";
import {
  resolveConfig,
  type FlightPlanConfig,
  type TargetLevel,
} from "@/domain/flight-plan/config";
import { weighOrder, type OrderWeight } from "@/domain/flight-plan/order-weight";
import { buildFlightPlan, type FlightPlanDTO } from "./flight-plan.repository.server";

type Client = SupabaseClient<Database>;
const n = (v: unknown) => Number(v ?? 0);

function friendly(error: { code?: string; message?: string }, what: string): Error {
  console.error(`${what} failed`, error);
  return new Error(
    error.code === "42501" ? "Sem acesso a esta empresa." : `Não foi possível carregar ${what}.`,
  );
}

/** Filter args shared by every sales RPC (undefined keys omitted for typing). */
function filterArgs(q: AnalyticsQuery) {
  return Object.fromEntries(
    Object.entries({
      p_channel: q.channel,
      p_branch: q.branch,
      p_seller: q.seller,
      p_state: q.state,
      p_city: q.city,
      p_category: q.category,
    }).filter(([, v]) => v !== undefined),
  );
}

export async function dataAsOf(supabase: Client, company: string): Promise<string> {
  const { data, error } = await supabase.rpc("data_as_of", { p_company: company });
  if (error) throw friendly(error, "a data de referência");
  return String(data);
}

async function loadConfig(supabase: Client): Promise<FlightPlanConfig> {
  const { data } = await supabase
    .from("metric_config")
    .select("config")
    .eq("metric_key", "flight_plan")
    .maybeSingle();
  return resolveConfig(data?.config);
}

// ---------- KPIs ----------

interface RawKpis {
  revenue: number;
  invoices: number;
  units: number;
  customers: number;
  newCustomers: number;
  orders: number;
}

async function kpis(supabase: Client, q: AnalyticsQuery, r: DateRange): Promise<RawKpis> {
  const { data, error } = await supabase.rpc("sales_kpis", {
    p_company: q.company,
    p_start: r.start,
    p_end: r.end,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "os indicadores de vendas");
  const k = data as unknown as RawKpis;
  const d = r.divisor;
  return {
    revenue: n(k.revenue) / d,
    invoices: n(k.invoices) / d,
    units: n(k.units) / d,
    customers: n(k.customers) / d,
    newCustomers: n(k.newCustomers) / d,
    orders: n(k.orders) / d,
  };
}

export type SalesKpiKey =
  | "revenue"
  | "target"
  | "target_attainment"
  | "sales_orders_count"
  | "orders"
  | "units"
  | "average_ticket"
  | "customers"
  | "new_customers"
  | "recurring_customers"
  | "avg_unit_price";

function derive(k: RawKpis, target: number | null): Record<SalesKpiKey, number | null> {
  return {
    revenue: k.revenue,
    target,
    target_attainment: target == null ? null : attainment(k.revenue, target),
    sales_orders_count: k.orders,
    orders: k.invoices,
    units: k.units,
    average_ticket: averageTicket({
      revenue: k.revenue,
      invoices: k.invoices,
      customers: k.customers,
      units: k.units,
    }),
    customers: k.customers,
    new_customers: k.newCustomers,
    recurring_customers: recurringCustomers(k.customers, k.newCustomers),
    avg_unit_price: averageUnitPrice(k.revenue, k.units),
  };
}

export interface SalesKpi {
  key: SalesKpiKey;
  value: number | null;
  comparisons: Comparison[];
}

export interface SalesSummaryDTO {
  asOf: string;
  range: DateRange & { state: string };
  activeLevel: TargetLevel;
  kpis: SalesKpi[];
  /** Flight Plan realized for the same filters (reconciliation). */
  flightPlanRealized: number;
}

export async function getSalesSummary(
  supabase: Client,
  q: AnalyticsQuery,
): Promise<SalesSummaryDTO> {
  const asOf = await dataAsOf(supabase, q.company);
  const range = periodRange(q.period, asOf);
  const ranges = ALL_COMPARISONS.map((k) => comparisonRange(k, q.period, asOf));
  const [cur, fp, ...bases] = await Promise.all([
    kpis(supabase, q, range),
    buildFlightPlan(supabase, q),
    ...ranges.map((r) => kpis(supabase, q, r)),
  ]);
  const target = fp.targets[fp.config.activeLevel];
  const curD = derive(cur, target);
  const baseD = bases.map((b) => derive(b, null));
  const keys = Object.keys(curD) as SalesKpiKey[];
  return {
    asOf,
    range,
    activeLevel: fp.config.activeLevel,
    flightPlanRealized: fp.summary.realized,
    kpis: keys.map((key) => ({
      key,
      value: curD[key],
      comparisons:
        key === "target" || key === "target_attainment"
          ? []
          : ALL_COMPARISONS.map((kind, i) => compare(kind, curD[key], baseD[i]![key])),
    })),
  };
}

// ---------- Timeline ----------

export type Grain = "day" | "week" | "month";
export interface TimelineBucket {
  bucket: string;
  revenue: number;
  units: number;
  invoices: number;
  ticket: number | null;
  /** Bucket starts after the as-of date (unknown, not zero). */
  future?: boolean;
}
export interface SalesTimelineDTO {
  grain: Grain;
  current: TimelineBucket[];
  previous: TimelineBucket[];
  lastYear: TimelineBucket[];
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const addMonths = (iso: string, months: number) => {
  const [y = 0, m = 1] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
};

/** Windows per grain: day = the month; week = 13 weeks; month = 12 months (all ending at the period cut). */
export function timelineWindows(period: string, asOf: string, grain: Grain) {
  const r = periodRange(period, asOf);
  const monthStart = `${period}-01`;
  const monthEnd = periodRange(period, "9999-12-31").end;
  let cur: { start: string; end: string };
  let prev: { start: string; end: string };
  if (grain === "day") {
    cur = { start: monthStart, end: monthEnd };
    prev = { start: addMonths(monthStart, -1), end: addDays(monthStart, -1) };
  } else if (grain === "week") {
    cur = { start: addDays(r.end, -7 * 13 + 1), end: r.end };
    prev = { start: addDays(cur.start, -7 * 13), end: addDays(cur.start, -1) };
  } else {
    cur = { start: addMonths(monthStart, -11), end: r.end };
    prev = { start: addMonths(monthStart, -23), end: addDays(addMonths(monthStart, -11), -1) };
  }
  const ly = {
    start: `${Number(cur.start.slice(0, 4)) - 1}${cur.start.slice(4)}`,
    end: `${Number(cur.end.slice(0, 4)) - 1}${cur.end.slice(4)}`.replace(/-02-29$/, "-02-28"),
  };
  return { cur, prev, ly };
}

async function timeline(
  supabase: Client,
  q: AnalyticsQuery,
  w: { start: string; end: string },
  grain: Grain,
): Promise<TimelineBucket[]> {
  const { data, error } = await supabase.rpc("sales_timeline", {
    p_company: q.company,
    p_start: w.start,
    p_end: w.end,
    p_grain: grain,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "a evolução de vendas");
  return (data as unknown as TimelineBucket[]).map((b) => {
    const revenue = n(b.revenue);
    const invoices = n(b.invoices);
    return {
      bucket: b.bucket,
      revenue,
      units: n(b.units),
      invoices,
      ticket: invoices ? revenue / invoices : null,
    };
  });
}

export async function getSalesTimeline(
  supabase: Client,
  q: AnalyticsQuery,
  grain: Grain,
): Promise<SalesTimelineDTO> {
  const asOf = await dataAsOf(supabase, q.company);
  const w = timelineWindows(q.period, asOf, grain);
  const [current, previous, lastYear] = await Promise.all([
    timeline(supabase, q, w.cur, grain),
    timeline(supabase, q, w.prev, grain),
    timeline(supabase, q, w.ly, grain),
  ]);
  // Days after the as-of date are not "zero sales", they are unknown.
  const cut = periodRange(q.period, asOf).end;
  return {
    grain,
    current: current.map((b) => (b.bucket > cut ? { ...b, future: true } : b)),
    previous,
    lastYear,
  };
}

// ---------- Breakdown ----------

export type Dimension = "seller" | "customer" | "product" | "category" | "state" | "city";
interface RawBreakdown {
  key: string | null;
  label: string | null;
  sub: string | null;
  category: string | null;
  revenue: number;
  units: number;
  invoices: number;
  customers: number;
  lastDate: string | null;
}
export interface BreakdownRow extends RawBreakdown {
  share: number | null;
  previous: number;
  variation: number | null;
  ticket: number | null;
}

async function breakdown(supabase: Client, q: AnalyticsQuery, r: DateRange, dim: Dimension) {
  const { data, error } = await supabase.rpc("sales_breakdown", {
    p_company: q.company,
    p_start: r.start,
    p_end: r.end,
    p_dim: dim,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "os drivers de vendas");
  return (data as unknown as RawBreakdown[]).map((x) => ({
    ...x,
    revenue: n(x.revenue),
    units: n(x.units),
    invoices: n(x.invoices),
    customers: n(x.customers),
  }));
}

export async function getSalesBreakdown(
  supabase: Client,
  q: AnalyticsQuery,
  dim: Dimension,
): Promise<{ dim: Dimension; total: number; rows: BreakdownRow[] }> {
  const asOf = await dataAsOf(supabase, q.company);
  const [cur, prev] = await Promise.all([
    breakdown(supabase, q, periodRange(q.period, asOf), dim),
    breakdown(supabase, q, comparisonRange("PREVIOUS_PERIOD", q.period, asOf), dim),
  ]);
  const total = cur.reduce((a, r) => a + r.revenue, 0);
  const prevMap = new Map(prev.map((p) => [p.key, p.revenue]));
  return {
    dim,
    total,
    rows: cur.map((r) => {
      const previous = prevMap.get(r.key) ?? 0;
      return {
        ...r,
        share: share(r.revenue, total),
        previous,
        variation: delta(r.revenue, previous),
        ticket: r.invoices ? r.revenue / r.invoices : null,
      };
    }),
  };
}

// ---------- Invoices / orders / items ----------

export interface InvoiceRow {
  id: string;
  number: string;
  date: string;
  competence: string;
  customer: string;
  seller: string | null;
  sellerId: string | null;
  city: string;
  state: string;
  status: "authorized" | "cancelled" | "denied" | "not_authorized";
  total: number;
  items: number;
  counted: boolean;
}

export async function getInvoices(supabase: Client, q: AnalyticsQuery): Promise<InvoiceRow[]> {
  const asOf = await dataAsOf(supabase, q.company);
  const r = periodRange(q.period, asOf);
  const { data, error } = await supabase.rpc("sales_invoices", {
    p_company: q.company,
    p_start: r.start,
    p_end: r.end,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "as notas fiscais");
  return (data as unknown as InvoiceRow[]).map((i) => ({
    ...i,
    total: n(i.total),
    items: n(i.items),
  }));
}

export async function getInvoiceDetail(supabase: Client, id: string) {
  const { data: inv, error } = await supabase
    .from("invoices")
    .select(
      "id, number, status, competence_date, total, company_id, customers(name, city, state), sellers(name), channels(name), branches(name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !inv) throw new Error("Nota fiscal não encontrada ou sem acesso.");
  const { data: items } = await supabase
    .from("invoice_items")
    .select("id, quantity, total, products(sku, name, category)")
    .eq("invoice_id", id);
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    date: inv.competence_date,
    total: n(inv.total),
    customer: inv.customers,
    seller: inv.sellers?.name ?? null,
    channel: inv.channels?.name ?? null,
    branch: inv.branches?.name ?? null,
    items: (items ?? []).map((it) => ({
      id: it.id,
      sku: it.products?.sku ?? null,
      product: it.products?.name ?? "",
      category: it.products?.category ?? "",
      qty: n(it.quantity),
      total: n(it.total),
      unitPrice: n(it.quantity) ? n(it.total) / n(it.quantity) : null,
    })),
  };
}

export interface OrderRow {
  id: string;
  number: string;
  status: "open" | "invoiced" | "cancelled";
  date: string;
  expectedDate: string | null;
  customer: string;
  seller: string | null;
  sellerId: string | null;
  total: number;
  items: number;
  ageDays: number;
  weight: (OrderWeight & { inForecastProbable: boolean }) | null;
}

export async function getOrders(supabase: Client, q: AnalyticsQuery) {
  const [asOf, cfg] = await Promise.all([dataAsOf(supabase, q.company), loadConfig(supabase)]);
  const { data, error } = await supabase.rpc("sales_orders_list", {
    p_company: q.company,
    p_as_of: asOf,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "os pedidos");
  const rows: OrderRow[] = (data as unknown as OrderRow[]).map((o) => {
    const total = n(o.total);
    const ageDays = n(o.ageDays);
    return {
      ...o,
      total,
      ageDays,
      items: n(o.items),
      weight:
        o.status === "open"
          ? {
              ...weighOrder(
                { ageDays, total, status: o.status, expectedDate: o.expectedDate },
                cfg,
              ),
              inForecastProbable: true,
            }
          : null,
    };
  });
  return { asOf, config: cfg, rows };
}

export interface ItemRow {
  invoice: string;
  invoiceId: string;
  date: string;
  sku: string | null;
  product: string;
  category: string;
  qty: number;
  unitPrice: number | null;
  total: number;
  customer: string;
  seller: string | null;
}

export async function getItems(supabase: Client, q: AnalyticsQuery): Promise<ItemRow[]> {
  const asOf = await dataAsOf(supabase, q.company);
  const r = periodRange(q.period, asOf);
  const { data, error } = await supabase.rpc("sales_items", {
    p_company: q.company,
    p_start: r.start,
    p_end: r.end,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "os itens");
  return (data as unknown as ItemRow[]).map((i) => ({
    ...i,
    qty: n(i.qty),
    total: n(i.total),
    unitPrice: i.unitPrice == null ? null : n(i.unitPrice),
  }));
}

// ---------- Vendedor 360 ----------

export interface HistoryPoint {
  month: string;
  revenue: number;
  target: number;
  attainment: number | null;
}

export interface Vendor360DTO {
  asOf: string;
  plan: FlightPlanDTO;
  kpis: Record<SalesKpiKey, number | null>;
  history: HistoryPoint[];
  averages: { m3: number | null; m6: number | null; m12: number | null };
  customers: BreakdownRow[];
  products: BreakdownRow[];
  team: string | null;
}

export async function getVendor360(
  supabase: Client,
  q: AnalyticsQuery & { seller: string },
): Promise<Vendor360DTO> {
  const asOf = await dataAsOf(supabase, q.company);
  const range = periodRange(q.period, asOf);
  const [plan, cur, hist, customers, products, team] = await Promise.all([
    buildFlightPlan(supabase, q),
    kpis(supabase, q, range),
    supabase.rpc("seller_history", {
      p_company: q.company,
      p_seller: q.seller,
      p_end: range.end,
      ...Object.fromEntries(Object.entries(filterArgs(q)).filter(([k]) => k !== "p_seller")),
    }),
    getSalesBreakdown(supabase, q, "customer"),
    getSalesBreakdown(supabase, q, "product"),
    supabase
      .from("sales_team_members")
      .select("sales_teams(name)")
      .eq("seller_id", q.seller)
      .is("valid_to", null)
      .maybeSingle(),
  ]);
  if (hist.error) throw friendly(hist.error, "o histórico do vendedor");
  if (!plan.vendors.length) throw new Error("Vendedor não encontrado ou sem acesso.");
  const level = plan.config.activeLevel;
  const history = (
    hist.data as unknown as {
      month: string;
      revenue: number;
      targets: Record<TargetLevel, number>;
    }[]
  ).map((h) => {
    const revenue = n(h.revenue);
    const target = n(h.targets[level]);
    return { month: h.month, revenue, target, attainment: attainment(revenue, target) };
  });
  // Averages over FULL months before the selected period.
  const closed = history.slice(0, -1).map((h) => h.revenue);
  const v = plan.vendors[0]!;
  return {
    asOf,
    plan,
    kpis: derive(cur, v.targets[level]),
    history,
    averages: {
      m3: trailingAverage(closed, 3),
      m6: trailingAverage(closed, 6),
      m12: trailingAverage(closed, 12),
    },
    customers: customers.rows,
    products: products.rows,
    team: (team.data?.sales_teams as { name: string } | null)?.name ?? null,
  };
}
