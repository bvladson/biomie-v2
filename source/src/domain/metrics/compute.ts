/**
 * Derived metrics. Pure functions over semantic-layer aggregates —
 * the ONLY place where ratios like attainment/forecast are calculated.
 */
export interface SalesAggregate {
  revenue: number;
  invoices: number;
  customers: number;
  units: number;
}

export function safeDiv(a: number, b: number): number | null {
  return b ? a / b : null;
}

export function delta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / previous;
}

export function averageTicket(a: SalesAggregate): number | null {
  return safeDiv(a.revenue, a.invoices);
}

export function attainment(revenue: number, target: number): number | null {
  return safeDiv(revenue, target);
}

export function forecastLinear(
  revenue: number,
  elapsed: number,
  total: number,
  isCurrent: boolean,
  isFuture: boolean,
): number | null {
  if (isFuture) return null;
  if (!isCurrent) return revenue;
  if (!elapsed) return null;
  return (revenue / elapsed) * total;
}

export function dailyRequired(
  revenue: number,
  target: number,
  elapsed: number,
  total: number,
): number | null {
  const remaining = total - elapsed;
  if (remaining <= 0) return null;
  return Math.max(target - revenue, 0) / remaining;
}

export function averageUnitPrice(revenue: number, units: number): number | null {
  return safeDiv(revenue, units);
}

export function recurringCustomers(customers: number, newCustomers: number): number {
  return Math.max(customers - newCustomers, 0);
}

/** Participation of a part in a total (0..1). */
export function share(part: number, total: number): number | null {
  return safeDiv(part, total);
}

/** Simple average of the last N values (ignores missing). */
export function trailingAverage(values: number[], n: number): number | null {
  const slice = values.slice(-n);
  return slice.length ? slice.reduce((a, v) => a + v, 0) / slice.length : null;
}

/** Average purchases (invoices) per active customer. */
export function purchaseFrequency(invoices: number, customers: number): number | null {
  return safeDiv(invoices, customers);
}

// ---------------- Financeiro ----------------

/** Overdue balance / open balance. */
export function overdueRate(overdue: number | null, open: number | null): number | null {
  return overdue == null || open == null ? null : safeDiv(overdue, open);
}

/** Amount-weighted average of days (Σ amount×days / Σ amount). */
export function weightedAverageDays(weightedDays: number, amount: number): number | null {
  return safeDiv(weightedDays, amount);
}

/** Average value per receivable title due in the period. */
export function receivableTicket(receivable: number, titles: number): number | null {
  return safeDiv(receivable, titles);
}
