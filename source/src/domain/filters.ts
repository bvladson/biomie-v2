import { z } from "zod";

/**
 * Global filters live in the URL (shareable, survive navigation).
 * Every module reads them through this schema — never ad-hoc.
 */
export const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

export const globalFiltersSchema = z.object({
  company: z.string().uuid().optional().catch(undefined),
  period: z.string().regex(periodRegex).optional().catch(undefined),
  channel: z.string().uuid().optional().catch(undefined),
  branch: z.string().uuid().optional().catch(undefined),
  seller: z.string().uuid().optional().catch(undefined),
  state: z.string().max(4).optional().catch(undefined),
  city: z.string().max(80).optional().catch(undefined),
  category: z.string().max(80).optional().catch(undefined),
});

export type GlobalFilters = z.infer<typeof globalFiltersSchema>;

/** Keys that depend on the selected company and must reset when it changes. */
export const COMPANY_SCOPED_KEYS = [
  "channel",
  "branch",
  "seller",
  "state",
  "city",
  "category",
] as const;

export function currentPeriod(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function parsePeriod(period: string): { year: number; month: number } {
  const [y = 0, m = 1] = period.split("-").map(Number);
  return { year: y, month: m };
}

export function shiftPeriod(period: string, months: number): string {
  const { year, month } = parsePeriod(period);
  const d = new Date(year, month - 1 + months, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Input accepted by analytical server functions. */
export const analyticsQuerySchema = z.object({
  company: z.string().uuid(),
  period: z.string().regex(periodRegex),
  channel: z.string().uuid().optional(),
  branch: z.string().uuid().optional(),
  seller: z.string().uuid().optional(),
  state: z.string().max(4).optional(),
  city: z.string().max(80).optional(),
  category: z.string().max(80).optional(),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
