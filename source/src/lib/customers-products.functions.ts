import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyticsQuerySchema } from "@/domain/filters";
import {
  getCustomer360,
  getCustomers,
  getProduct360,
  getProducts,
} from "./repositories/customers-products.repository.server";

export const fetchCustomers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    analyticsQuerySchema.extend({ inactiveDays: z.number().int().min(1).max(1000) }).parse(i),
  )
  .handler(({ data, context }) => {
    const { inactiveDays, ...q } = data;
    return getCustomers(context.supabase, q, inactiveDays);
  });

export const fetchCustomer360 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => analyticsQuerySchema.extend({ customer: z.string().uuid() }).parse(i))
  .handler(({ data, context }) => getCustomer360(context.supabase, data));

export const fetchProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    analyticsQuerySchema
      .extend({ window: z.enum(["30d", "90d", "180d", "12m"]).optional() })
      .parse(i),
  )
  .handler(({ data, context }) => {
    const { window, ...q } = data;
    return getProducts(context.supabase, q, window);
  });

export const fetchProduct360 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    analyticsQuerySchema
      .extend({ product: z.string().uuid(), grain: z.enum(["month", "week"]) })
      .parse(i),
  )
  .handler(({ data, context }) => getProduct360(context.supabase, data));
