import { queryOptions } from "@tanstack/react-query";
import {
  fetchCustomer360,
  fetchCustomers,
  fetchProduct360,
  fetchProducts,
} from "./customers-products.functions";
import type { QuickWindow } from "@/domain/comparison";
import { getAppContext } from "./app.functions";
import { getCockpit, getFilterOptions } from "./analytics.functions";
import type { AnalyticsQuery } from "@/domain/filters";

export const appContextQuery = () =>
  queryOptions({
    queryKey: ["app-context"],
    queryFn: () => getAppContext(),
    staleTime: 5 * 60_000,
  });

export const filterOptionsQuery = (company: string) =>
  queryOptions({
    queryKey: ["filter-options", company],
    queryFn: () => getFilterOptions({ data: { company } }),
    staleTime: 10 * 60_000,
  });

export const cockpitQuery = (q: AnalyticsQuery) =>
  queryOptions({
    queryKey: ["cockpit", q],
    queryFn: () => getCockpit({ data: q }),
    staleTime: 60_000,
  });

import { getFlightPlan, getVendorFlightPlan } from "./flight-plan.functions";

export const flightPlanQuery = (q: AnalyticsQuery) =>
  queryOptions({
    queryKey: ["flight-plan", q],
    queryFn: () => getFlightPlan({ data: q }),
    staleTime: 60_000,
  });

export const vendorFlightPlanQuery = (q: AnalyticsQuery & { seller: string }) =>
  queryOptions({
    queryKey: ["flight-plan-vendor", q],
    queryFn: () => getVendorFlightPlan({ data: q }),
    staleTime: 60_000,
  });

import {
  fetchInvoices,
  fetchItems,
  fetchOrders,
  fetchSalesBreakdown,
  fetchSalesSummary,
  fetchSalesTimeline,
  fetchVendor360,
} from "./sales.functions";

type Grain = "day" | "week" | "month";
type Dim = "seller" | "customer" | "product" | "category" | "state" | "city";

export const salesSummaryQuery = (q: AnalyticsQuery) =>
  queryOptions({ queryKey: ["sales-summary", q], queryFn: () => fetchSalesSummary({ data: q }) });
export const salesTimelineQuery = (q: AnalyticsQuery, grain: Grain) =>
  queryOptions({
    queryKey: ["sales-timeline", q, grain],
    queryFn: () => fetchSalesTimeline({ data: { ...q, grain } }),
  });
export const salesBreakdownQuery = (q: AnalyticsQuery, dim: Dim) =>
  queryOptions({
    queryKey: ["sales-breakdown", q, dim],
    queryFn: () => fetchSalesBreakdown({ data: { ...q, dim } }),
  });
export const invoicesQuery = (q: AnalyticsQuery) =>
  queryOptions({ queryKey: ["sales-invoices", q], queryFn: () => fetchInvoices({ data: q }) });
export const ordersQuery = (q: AnalyticsQuery) =>
  queryOptions({ queryKey: ["sales-orders", q], queryFn: () => fetchOrders({ data: q }) });
export const itemsQuery = (q: AnalyticsQuery) =>
  queryOptions({ queryKey: ["sales-items", q], queryFn: () => fetchItems({ data: q }) });
export const vendor360Query = (q: AnalyticsQuery & { seller: string }) =>
  queryOptions({ queryKey: ["vendor-360", q], queryFn: () => fetchVendor360({ data: q }) });

export const customersQuery = (q: AnalyticsQuery, inactiveDays: number) =>
  queryOptions({
    queryKey: ["customers", q, inactiveDays],
    queryFn: () => fetchCustomers({ data: { ...q, inactiveDays } }),
  });
export const customer360Query = (q: AnalyticsQuery & { customer: string }) =>
  queryOptions({ queryKey: ["customer360", q], queryFn: () => fetchCustomer360({ data: q }) });
export const productsQuery = (q: AnalyticsQuery, window?: QuickWindow) =>
  queryOptions({
    queryKey: ["products", q, window ?? null],
    queryFn: () => fetchProducts({ data: window ? { ...q, window } : q }),
  });
export const product360Query = (q: AnalyticsQuery & { product: string; grain: "month" | "week" }) =>
  queryOptions({ queryKey: ["product360", q], queryFn: () => fetchProduct360({ data: q }) });

import {
  fetchCustomerFinance,
  fetchFinanceCapabilities,
  fetchFinanceSummary,
  fetchFinanceTitles,
} from "./finance.functions";

export const financeCapabilitiesQuery = () =>
  queryOptions({
    queryKey: ["finance-capabilities"],
    queryFn: () => fetchFinanceCapabilities(),
    staleTime: 5 * 60_000,
  });
export const financeSummaryQuery = (q: AnalyticsQuery) =>
  queryOptions({
    queryKey: ["finance-summary", q],
    queryFn: () => fetchFinanceSummary({ data: q }),
  });
export const financeTitlesQuery = (q: AnalyticsQuery) =>
  queryOptions({ queryKey: ["finance-titles", q], queryFn: () => fetchFinanceTitles({ data: q }) });
export const customerFinanceQuery = (company: string, customer: string) =>
  queryOptions({
    queryKey: ["customer-finance", company, customer],
    queryFn: () => fetchCustomerFinance({ data: { company, customer } }),
  });
