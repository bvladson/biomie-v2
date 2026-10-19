import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { TargetLevel } from "@/domain/flight-plan/config";
import { parsePeriod, type AnalyticsQuery } from "@/domain/filters";
import {
  attainment,
  averageTicket,
  dailyRequired,
  delta,
  forecastLinear,
  type SalesAggregate,
} from "@/domain/metrics/compute";

type Client = SupabaseClient<Database>;

interface RawCockpit {
  period: { start: string; end: string; cut: string; isCurrent: boolean; isFuture: boolean };
  comparison: {
    previousMonth: { start: string; end: string };
    previousYear: { start: string; end: string };
  };
  isDemo: boolean;
  current: SalesAggregate;
  previousMonth: SalesAggregate;
  previousYear: SalesAggregate;
  target: number;
  targetLevel: TargetLevel;
  portfolio: number;
  portfolioOrders: number;
  workingDays: { total: number; elapsed: number };
  daily: {
    date: string;
    working: boolean;
    revenue: number | null;
    cumulative: number | null;
    targetCumulative: number;
  }[];
  sellers: { id: string; name: string; revenue: number; invoices: number; target: number }[];
  drivers: Record<
    "products" | "customers" | "categories" | "states",
    { label: string; value: number }[]
  >;
}

export interface KpiValue {
  key: string;
  value: number | null;
  vsPreviousMonth: number | null;
  vsPreviousYear: number | null;
  hint?: string;
}

export interface CockpitDTO {
  period: RawCockpit["period"];
  comparison: RawCockpit["comparison"];
  isDemo: boolean;
  targetLevel: TargetLevel;
  kpis: Record<string, KpiValue>;
  workingDays: RawCockpit["workingDays"];
  daily: RawCockpit["daily"];
  sellers: (RawCockpit["sellers"][number] & { attainment: number | null })[];
  drivers: RawCockpit["drivers"];
}

const num = (v: unknown) => Number(v ?? 0);

function normAgg(a: SalesAggregate): SalesAggregate {
  return {
    revenue: num(a.revenue),
    invoices: num(a.invoices),
    customers: num(a.customers),
    units: num(a.units),
  };
}

export async function fetchCockpit(supabase: Client, q: AnalyticsQuery): Promise<CockpitDTO> {
  const { year, month } = parsePeriod(q.period);
  // Optional filters must be omitted (not undefined) for the RPC typing.
  const args = Object.fromEntries(
    Object.entries({
      p_company: q.company,
      p_year: year,
      p_month: month,
      p_channel: q.channel,
      p_branch: q.branch,
      p_seller: q.seller,
      p_state: q.state,
      p_city: q.city,
      p_category: q.category,
    }).filter(([, v]) => v !== undefined),
  ) as { p_company: string; p_year: number; p_month: number };
  const { data, error } = await supabase.rpc("cockpit_summary", args);
  if (error) {
    console.error("cockpit_summary failed", error);
    throw new Error(
      error.code === "42501"
        ? "Sem acesso a esta empresa."
        : "Não foi possível carregar o cockpit.",
    );
  }
  const raw = data as unknown as RawCockpit;
  const cur = normAgg(raw.current);
  const pm = normAgg(raw.previousMonth);
  const py = normAgg(raw.previousYear);
  const target = num(raw.target);
  const wd = raw.workingDays;

  const kpis: Record<string, KpiValue> = {
    revenue: {
      key: "revenue",
      value: cur.revenue,
      vsPreviousMonth: delta(cur.revenue, pm.revenue),
      vsPreviousYear: delta(cur.revenue, py.revenue),
    },
    target: { key: "target", value: target, vsPreviousMonth: null, vsPreviousYear: null },
    target_attainment: {
      key: "target_attainment",
      value: attainment(cur.revenue, target),
      vsPreviousMonth: null,
      vsPreviousYear: null,
    },
    forecast: {
      key: "forecast",
      value: forecastLinear(
        cur.revenue,
        wd.elapsed,
        wd.total,
        raw.period.isCurrent,
        raw.period.isFuture,
      ),
      vsPreviousMonth: null,
      vsPreviousYear: null,
    },
    portfolio: {
      key: "portfolio",
      value: num(raw.portfolio),
      vsPreviousMonth: null,
      vsPreviousYear: null,
      hint: `${raw.portfolioOrders} pedidos em aberto`,
    },
    average_ticket: {
      key: "average_ticket",
      value: averageTicket(cur),
      vsPreviousMonth: delta(averageTicket(cur), averageTicket(pm)),
      vsPreviousYear: delta(averageTicket(cur), averageTicket(py)),
    },
    customers: {
      key: "customers",
      value: cur.customers,
      vsPreviousMonth: delta(cur.customers, pm.customers),
      vsPreviousYear: delta(cur.customers, py.customers),
    },
    orders: {
      key: "orders",
      value: cur.invoices,
      vsPreviousMonth: delta(cur.invoices, pm.invoices),
      vsPreviousYear: delta(cur.invoices, py.invoices),
    },
    working_days: {
      key: "working_days",
      value: wd.total,
      vsPreviousMonth: null,
      vsPreviousYear: null,
      hint: `${wd.elapsed} decorridos · ${Math.max(wd.total - wd.elapsed, 0)} restantes`,
    },
    daily_required: {
      key: "daily_required",
      value: dailyRequired(cur.revenue, target, wd.elapsed, wd.total),
      vsPreviousMonth: null,
      vsPreviousYear: null,
      hint: "por dia útil restante",
    },
  };

  return {
    period: raw.period,
    comparison: raw.comparison,
    isDemo: raw.isDemo,
    targetLevel: raw.targetLevel ?? "ACTIVE",
    kpis,
    workingDays: wd,
    daily: raw.daily.map((d) => ({
      ...d,
      revenue: d.revenue == null ? null : num(d.revenue),
      cumulative: d.cumulative == null ? null : num(d.cumulative),
      targetCumulative: num(d.targetCumulative),
    })),
    sellers: raw.sellers.map((s) => ({
      ...s,
      revenue: num(s.revenue),
      target: num(s.target),
      attainment: attainment(num(s.revenue), num(s.target)),
    })),
    drivers: {
      products: raw.drivers.products.map((d) => ({ ...d, value: num(d.value) })),
      customers: raw.drivers.customers.map((d) => ({ ...d, value: num(d.value) })),
      categories: raw.drivers.categories.map((d) => ({ ...d, value: num(d.value) })),
      states: raw.drivers.states.map((d) => ({ ...d, value: num(d.value) })),
    },
  };
}

export async function fetchFilterOptions(supabase: Client, company: string) {
  const [channels, branches, sellers, customers, products] = await Promise.all([
    supabase.from("channels").select("id,name").eq("company_id", company).order("name"),
    supabase.from("branches").select("id,name").eq("company_id", company).order("name"),
    supabase
      .from("sellers")
      .select("id,name")
      .eq("company_id", company)
      .eq("active", true)
      .order("name"),
    supabase.from("customers").select("state,city").eq("company_id", company),
    supabase.from("products").select("category").eq("company_id", company),
  ]);
  for (const r of [channels, branches, sellers, customers, products])
    if (r.error) throw new Error("Falha ao carregar filtros.");
  const states = [...new Set((customers.data ?? []).map((c) => c.state))].sort();
  const cities = [
    ...new Map(
      (customers.data ?? []).map((c) => [`${c.state}:${c.city}`, { city: c.city, state: c.state }]),
    ).values(),
  ].sort((a, b) => a.city.localeCompare(b.city));
  const categories = [...new Set((products.data ?? []).map((p) => p.category))].sort();
  return {
    channels: channels.data ?? [],
    branches: branches.data ?? [],
    sellers: sellers.data ?? [],
    states,
    cities,
    categories,
  };
}
