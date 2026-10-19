import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AnalyticsQuery } from "@/domain/filters";
import { periodRange, quickWindowRange, type QuickWindow } from "@/domain/comparison";
import {
  averageTicket,
  averageUnitPrice,
  purchaseFrequency,
  recurringCustomers,
  share,
} from "@/domain/metrics/compute";
import { computeRfm, resolveRfmConfig, type RfmResult } from "@/domain/customers/rfm";
import { dataAsOf } from "./sales.repository.server";

type Client = SupabaseClient<Database>;
const n = (v: unknown) => Number(v ?? 0);

function friendly(error: { code?: string; message?: string }, what: string): Error {
  console.error(`${what} failed`, error);
  return new Error(
    error.code === "42501" ? "Sem acesso a esta empresa." : `Não foi possível carregar ${what}.`,
  );
}

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

async function resolveRange(supabase: Client, q: AnalyticsQuery, window?: QuickWindow) {
  const asOf = await dataAsOf(supabase, q.company);
  const r = window ? quickWindowRange(window, asOf) : periodRange(q.period, asOf);
  return { asOf, start: r.start, end: r.end };
}

// ---------------- Customers ----------------

export interface CustomerRow {
  id: string;
  name: string;
  document: string | null;
  city: string;
  state: string;
  sellerId: string | null;
  seller: string | null;
  firstDate: string;
  lastDate: string;
  daysSince: number;
  purchases: number;
  purchasesAll: number;
  lifetimeRevenue: number;
  revenue: number;
  units: number;
  ticket: number | null;
  share: number | null;
}

export interface CustomersDTO {
  asOf: string;
  range: { start: string; end: string };
  summary: {
    active: number;
    new: number;
    recurring: number;
    revenue: number;
    invoices: number;
    ticket: number | null;
    frequency: number | null;
    inactive: number;
    inactiveDays: number;
    unassignedRevenue: number;
  };
  rows: CustomerRow[];
}

export async function getCustomers(
  supabase: Client,
  q: AnalyticsQuery,
  inactiveDays = 90,
): Promise<CustomersDTO> {
  const { asOf, start, end } = await resolveRange(supabase, q);
  const { data, error } = await supabase.rpc("customers_overview", {
    p_company: q.company,
    p_start: start,
    p_end: end,
    p_as_of: asOf,
    p_inactive_days: inactiveDays,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "os clientes");
  const raw = data as unknown as { summary: Record<string, number>; rows: CustomerRow[] };
  const s = raw.summary;
  const revenue = n(s["revenue"]);
  const invoices = n(s["invoices"]);
  const active = n(s["active"]);
  const nw = n(s["new"]);
  return {
    asOf,
    range: { start, end },
    summary: {
      active,
      new: nw,
      recurring: recurringCustomers(active, nw),
      revenue,
      invoices,
      ticket: averageTicket({ revenue, invoices, customers: active, units: 0 }),
      frequency: purchaseFrequency(invoices, active),
      inactive: n(s["inactive"]),
      inactiveDays: n(s["inactiveDays"]),
      unassignedRevenue: n(s["unassignedRevenue"]),
    },
    rows: raw.rows.map((r) => {
      const rev = n(r.revenue);
      const nfs = n(r.purchases);
      return {
        ...r,
        revenue: rev,
        purchases: nfs,
        purchasesAll: n(r.purchasesAll),
        lifetimeRevenue: n(r.lifetimeRevenue),
        units: n(r.units),
        daysSince: n(r.daysSince),
        ticket: averageTicket({ revenue: rev, invoices: nfs, customers: 1, units: 0 }),
        share: share(rev, revenue),
      };
    }),
  };
}

export interface Customer360DTO {
  asOf: string;
  range: { start: string; end: string };
  customer: {
    id: string;
    name: string;
    document: string | null;
    city: string;
    state: string;
    sellerId: string | null;
    seller: string | null;
    firstDate: string | null;
    lastDate: string | null;
  };
  kpis: {
    lifetimeRevenue: number;
    revenue: number;
    orders: number;
    invoices: number;
    ticket: number | null;
    frequency: number;
    recency: number | null;
    products: number;
    share: number | null;
    monetary12m: number;
  };
  rfm: RfmResult | null;
  history: { month: string; revenue: number; invoices: number; ticket: number | null }[];
  products: {
    id: string;
    sku: string | null;
    name: string;
    category: string;
    units: number;
    revenue: number;
    /** Last purchase of this product inside the selected period/filters. */
    lastDate: string;
    /** Last purchase of this product in the customer's full history. */
    lastDateAll: string | null;
    share: number | null;
  }[];
  invoices: { id: string; number: string; date: string; seller: string | null; total: number }[];
}

export async function getCustomer360(
  supabase: Client,
  q: AnalyticsQuery & { customer: string },
): Promise<Customer360DTO> {
  const { asOf, start, end } = await resolveRange(supabase, q);
  const [res, cfg] = await Promise.all([
    supabase.rpc("customer_360", {
      p_company: q.company,
      p_customer: q.customer,
      p_start: start,
      p_end: end,
      p_as_of: asOf,
      ...filterArgs(q),
    }),
    supabase.from("metric_config").select("config").eq("metric_key", "rfm").maybeSingle(),
  ]);
  if (res.error) throw friendly(res.error, "o cliente");
  if (!res.data) throw new Error("Cliente não encontrado ou fora do seu escopo.");
  type Raw = Omit<Customer360DTO, "kpis" | "rfm" | "asOf" | "range"> & {
    lifetime: { revenue: number; invoices: number; invoices12m: number; revenue12m: number };
    period: {
      revenue: number;
      invoices: number;
      units: number;
      products: number;
      companyRevenue: number;
      orders: number;
    };
  };
  const d = res.data as unknown as Raw;
  const p = d.period;
  const revenue = n(p.revenue);
  const invoices = n(p.invoices);
  const recency = d.customer.lastDate
    ? Math.round(
        (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${d.customer.lastDate}T00:00:00Z`)) /
          86_400_000,
      )
    : null;
  const frequency = n(d.lifetime.invoices12m);
  const monetary12m = n(d.lifetime.revenue12m);
  const firstInPeriod =
    !!d.customer.firstDate && d.customer.firstDate >= start && d.customer.firstDate <= end;
  return {
    asOf,
    range: { start, end },
    customer: d.customer,
    kpis: {
      lifetimeRevenue: n(d.lifetime.revenue),
      revenue,
      orders: n(p.orders),
      invoices,
      ticket: averageTicket({ revenue, invoices, customers: 1, units: 0 }),
      frequency,
      recency,
      products: n(p.products),
      share: share(revenue, n(p.companyRevenue)),
      monetary12m,
    },
    rfm: computeRfm(
      { recencyDays: recency, frequency, monetary: monetary12m, isNew: firstInPeriod },
      resolveRfmConfig(cfg.data?.config),
    ),
    history: d.history.map((h) => {
      const rev = n(h.revenue);
      const nfs = n(h.invoices);
      return {
        month: h.month,
        revenue: rev,
        invoices: nfs,
        ticket: averageTicket({ revenue: rev, invoices: nfs, customers: 1, units: 0 }),
      };
    }),
    products: d.products.map((x) => ({
      ...x,
      units: n(x.units),
      revenue: n(x.revenue),
      share: share(n(x.revenue), revenue),
    })),
    invoices: d.invoices.map((x) => ({ ...x, total: n(x.total) })),
  };
}

// ---------------- Products ----------------

export interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  category: string;
  units: number;
  revenue: number;
  avgPrice: number | null;
  customers: number;
  sellers: number;
  lastDate: string;
  share: number | null;
}

export interface ProductsDTO {
  asOf: string;
  range: { start: string; end: string };
  window: QuickWindow | null;
  summary: {
    products: number;
    units: number;
    revenue: number;
    avgPrice: number | null;
    customers: number;
    categories: number;
  };
  rows: ProductRow[];
}

export async function getProducts(
  supabase: Client,
  q: AnalyticsQuery,
  window?: QuickWindow,
): Promise<ProductsDTO> {
  const { asOf, start, end } = await resolveRange(supabase, q, window);
  const { data, error } = await supabase.rpc("products_overview", {
    p_company: q.company,
    p_start: start,
    p_end: end,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "os produtos");
  const raw = data as unknown as { summary: Record<string, number>; rows: ProductRow[] };
  const s = raw.summary;
  const revenue = n(s["revenue"]);
  const units = n(s["units"]);
  return {
    asOf,
    range: { start, end },
    window: window ?? null,
    summary: {
      products: n(s["products"]),
      units,
      revenue,
      avgPrice: averageUnitPrice(revenue, units),
      customers: n(s["customers"]),
      categories: n(s["categories"]),
    },
    rows: raw.rows.map((r) => ({
      ...r,
      units: n(r.units),
      revenue: n(r.revenue),
      customers: n(r.customers),
      sellers: n(r.sellers),
      avgPrice: averageUnitPrice(n(r.revenue), n(r.units)),
      share: share(n(r.revenue), revenue),
    })),
  };
}

export interface Product360DTO {
  asOf: string;
  range: { start: string; end: string };
  grain: "month" | "week";
  product: {
    id: string;
    sku: string | null;
    name: string;
    category: string;
    basePrice: number;
    lastSale: string | null;
  };
  kpis: {
    revenue: number;
    units: number;
    avgPrice: number | null;
    customers: number;
    sellers: number;
    invoices: number;
  };
  history: { bucket: string; revenue: number; units: number; avgPrice: number | null }[];
  customers: {
    id: string;
    name: string;
    place: string;
    units: number;
    revenue: number;
    avgPrice: number | null;
    lastDate: string;
    share: number | null;
  }[];
  sellers: {
    id: string | null;
    name: string | null;
    units: number;
    revenue: number;
    customers: number;
    share: number | null;
  }[];
}

export async function getProduct360(
  supabase: Client,
  q: AnalyticsQuery & { product: string; grain: "month" | "week" },
): Promise<Product360DTO> {
  const { asOf, start, end } = await resolveRange(supabase, q);
  // History: last 12 months (monthly) or last 26 weeks (weekly) up to period end.
  const e = new Date(`${end}T00:00:00Z`);
  const histStart =
    q.grain === "month"
      ? new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 11, 1))
      : new Date(e.getTime() - 26 * 7 * 86_400_000);
  const { data, error } = await supabase.rpc("product_360", {
    p_company: q.company,
    p_product: q.product,
    p_start: start,
    p_end: end,
    p_hist_start: histStart.toISOString().slice(0, 10),
    p_grain: q.grain,
    ...filterArgs(q),
  });
  if (error) throw friendly(error, "o produto");
  if (!data) throw new Error("Produto não encontrado.");
  type Raw = {
    product: Product360DTO["product"];
    period: Record<string, number>;
    history: { bucket: string; revenue: number; units: number }[];
    customers: Product360DTO["customers"];
    sellers: Product360DTO["sellers"];
  };
  const d = data as unknown as Raw;
  const revenue = n(d.period["revenue"]);
  const units = n(d.period["units"]);
  return {
    asOf,
    range: { start, end },
    grain: q.grain,
    product: { ...d.product, basePrice: n(d.product.basePrice) },
    kpis: {
      revenue,
      units,
      avgPrice: averageUnitPrice(revenue, units),
      customers: n(d.period["customers"]),
      sellers: n(d.period["sellers"]),
      invoices: n(d.period["invoices"]),
    },
    history: d.history.map((h) => ({
      bucket: h.bucket,
      revenue: n(h.revenue),
      units: n(h.units),
      avgPrice: averageUnitPrice(n(h.revenue), n(h.units)),
    })),
    customers: d.customers.map((c) => ({
      ...c,
      units: n(c.units),
      revenue: n(c.revenue),
      avgPrice: averageUnitPrice(n(c.revenue), n(c.units)),
      share: share(n(c.revenue), revenue),
    })),
    sellers: d.sellers.map((s) => ({
      ...s,
      units: n(s.units),
      revenue: n(s.revenue),
      customers: n(s.customers),
      share: share(n(s.revenue), revenue),
    })),
  };
}
