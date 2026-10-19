import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyticsQuerySchema } from "@/domain/filters";
import {
  getInvoiceDetail,
  getInvoices,
  getItems,
  getOrders,
  getSalesBreakdown,
  getSalesSummary,
  getSalesTimeline,
  getVendor360,
} from "./repositories/sales.repository.server";

/** Thin RPC layer: every read model is one aggregated call (no per-card requests). */
export const fetchSalesSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.parse(i))
  .handler(({ data, context }) => getSalesSummary(context.supabase, data));

export const fetchSalesTimeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    analyticsQuerySchema.extend({ grain: z.enum(["day", "week", "month"]) }).parse(i),
  )
  .handler(({ data, context }) => {
    const { grain, ...q } = data;
    return getSalesTimeline(context.supabase, q, grain);
  });

export const fetchSalesBreakdown = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    analyticsQuerySchema
      .extend({ dim: z.enum(["seller", "customer", "product", "category", "state", "city"]) })
      .parse(i),
  )
  .handler(({ data, context }) => {
    const { dim, ...q } = data;
    return getSalesBreakdown(context.supabase, q, dim);
  });

export const fetchInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.parse(i))
  .handler(({ data, context }) => getInvoices(context.supabase, data));

export const fetchInvoiceDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(({ data, context }) => getInvoiceDetail(context.supabase, data.id));

export const fetchOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.parse(i))
  .handler(({ data, context }) => getOrders(context.supabase, data));

export const fetchItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.parse(i))
  .handler(({ data, context }) => getItems(context.supabase, data));

export const fetchVendor360 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.extend({ seller: z.string().uuid() }).parse(i))
  .handler(({ data, context }) => getVendor360(context.supabase, data));
