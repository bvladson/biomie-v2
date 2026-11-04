/**
 * FlightPlanEngine — the ONLY place Flight Plan formulas live.
 * Pure, deterministic functions over raw facts returned by the read model
 * (flight_plan_v2_dataset). Screens never calculate: they receive results.
 *
 * Conventions:
 * - Working days are weighted: Mon–Fri 1, Saturday = company weight (D2), Sunday/holiday 0.
 * - Working days elapsed INCLUDE today.
 * - Closed period: elapsed = total, forecasts collapse to realized.
 * - Future period: nothing realized yet; only target and required pace.
 * - Thresholds and weights come from metric_config.flight_plan (FlightPlanConfig).
 */
import type {
  Alert,
  AlertType,
  CalendarDay,
  Channel,
  FlightStatus,
  Metrics,
  Money,
  PeriodState,
  PeriodSummary,
  TargetLevel,
  TargetSet,
  TimelinePoint,
  WeekPace,
  YearMonthRow,
} from "@/flight-plan/api/contract";
import { DEFAULT_FLIGHT_PLAN_CONFIG, type FlightPlanConfig } from "./config";
import { addDays, daysOfMonth, diffDays, monthEnd, mondayOf, weekday } from "./dates";
import { weighOrder } from "./order-weight";

export const round2 = (v: number) => Math.round(v * 100) / 100;
const LEVELS: TargetLevel[] = ["BASE", "ACTIVE", "CHALLENGE"];

// ---------- Calendar ----------
export function dayWeight(
  date: string,
  saturdayWeight: number,
  holidays: Map<string, string>,
): number {
  if (holidays.has(date)) return 0;
  const w = weekday(date);
  if (w === 0) return 0;
  if (w === 6) return saturdayWeight;
  return 1;
}

export function buildCalendar(
  month: string,
  saturdayWeight: number,
  holidays: Map<string, string>,
): CalendarDay[] {
  return daysOfMonth(month).map((date) => ({
    date,
    weight: dayWeight(date, saturdayWeight, holidays),
    holiday: holidays.get(date) ?? null,
  }));
}

export const sumWeights = (days: CalendarDay[]) => round2(days.reduce((s, d) => s + d.weight, 0));

export function periodState(month: string, today: string): PeriodState {
  if (today < `${month}-01`) return "future";
  if (today > monthEnd(month)) return "closed";
  return "current";
}

/** Working days elapsed, including today. */
export function elapsedWorkdays(calendar: CalendarDay[], today: string): number {
  return round2(calendar.filter((d) => d.date <= today).reduce((s, d) => s + d.weight, 0));
}

/** Working days still ahead in a month (0 when closed, all of them when future). */
export function remainingWorkdays(calendar: CalendarDay[], month: string, today: string): number {
  const state = periodState(month, today);
  const total = sumWeights(calendar);
  if (state === "closed") return 0;
  if (state === "future") return total;
  return round2(Math.max(0, total - elapsedWorkdays(calendar, today)));
}

// ---------- Status ----------
export function statusFromRatio(
  ratio: number | null,
  cfg: FlightPlanConfig = DEFAULT_FLIGHT_PLAN_CONFIG,
): FlightStatus | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio >= cfg.status.onTrack) return "ON_TRACK";
  if (ratio >= cfg.status.attention) return "ATTENTION";
  if (ratio >= cfg.status.risk) return "RISK";
  return "CRITICAL";
}
export const STATUS_RANK: Record<FlightStatus, number> = {
  ON_TRACK: 0,
  ATTENTION: 1,
  RISK: 2,
  CRITICAL: 3,
};
export const STATUS_LABEL: Record<FlightStatus, string> = {
  ON_TRACK: "No plano",
  ATTENTION: "Atenção",
  RISK: "Em risco",
  CRITICAL: "Crítico",
};

// ---------- Portfolio ----------
export interface OpenOrder {
  id: string;
  sellerId: string | null;
  customer?: string;
  amount: Money;
  openedAt: string;
  expectedDate: string | null;
}

/** Order classification for the month (delegates the weight to the OrderWeightModel). */
export function classifyOrder(
  o: OpenOrder,
  today: string,
  end: string,
  cfg: FlightPlanConfig = DEFAULT_FLIGHT_PLAN_CONFIG,
) {
  const age = diffDays(today, o.openedAt);
  const w = weighOrder({ ageDays: age, total: o.amount, expectedDate: o.expectedDate }, cfg, {
    today,
    periodEnd: end,
  });
  return {
    age,
    late: w.late,
    outOfMonth: w.outOfPeriod,
    weight: w.weight,
    fresh: w.inForecastBase,
  };
}

// ---------- Metrics ----------
export interface MetricsInput {
  target: Money | null;
  realized: Money;
  calendar: CalendarDay[];
  today: string;
  month: string;
  orders: OpenOrder[];
  commits: Money[];
}

export function computeMetrics(
  i: MetricsInput,
  cfg: FlightPlanConfig = DEFAULT_FLIGHT_PLAN_CONFIG,
): Metrics {
  const state = periodState(i.month, i.today);
  const end = monthEnd(i.month);
  const total = sumWeights(i.calendar);
  const elapsed =
    state === "future" ? 0 : state === "closed" ? total : elapsedWorkdays(i.calendar, i.today);
  const remaining = round2(Math.max(0, total - elapsed));
  const realized = state === "future" ? 0 : round2(i.realized);
  const target = i.target;

  let portfolio = 0;
  let weighted = 0;
  let late = 0;
  let freshAmount = 0;
  if (state !== "closed") {
    for (const o of i.orders) {
      const c = classifyOrder(o, i.today, end, cfg);
      portfolio += o.amount;
      weighted += o.amount * c.weight;
      if (c.late) late += o.amount;
      if (c.fresh) freshAmount += o.amount;
    }
  }

  const idealToday = target === null || total === 0 ? null : round2((target * elapsed) / total);
  const gap = target === null ? null : round2(Math.max(0, target - realized));
  const pace = elapsed > 0 ? round2(realized / elapsed) : null;
  const required = gap === null ? null : remaining > 0 ? round2(gap / remaining) : null;
  const unreachable = gap !== null && gap > 0 && remaining === 0;
  const closed = state === "closed";
  const ratio = paceRatio(target, realized, idealToday, state);

  return {
    target,
    realized,
    attainment: target && target > 0 ? realized / target : null,
    idealToday,
    deviation: idealToday === null ? null : round2(realized - idealToday),
    remainingGap: gap,
    workdaysTotal: total,
    workdaysElapsed: elapsed,
    workdaysRemaining: remaining,
    currentDailyPace: pace,
    requiredDailyPace: required,
    gapUnreachable: unreachable,
    runRateForecast: closed ? realized : pace === null ? null : round2(pace * total),
    forecastBase: closed ? realized : round2(realized + freshAmount),
    forecastProbable: closed ? realized : round2(realized + weighted),
    forecastCommit: i.commits.length ? round2(i.commits.reduce((s, v) => s + v, 0)) : null,
    portfolio: round2(portfolio),
    portfolioWeighted: round2(weighted),
    lateOrdersAmount: round2(late),
    gapCoverage: gap && gap > 0 ? weighted / gap : null,
    status: statusFromRatio(ratio, cfg),
  };
}

/** Ratio used for status: realized / ideal while open, realized / target once closed. */
export function paceRatio(
  target: Money | null,
  realized: Money,
  idealToday: Money | null,
  state: PeriodState,
): number | null {
  if (target === null || target <= 0) return null;
  if (state === "closed") return realized / target;
  if (state === "future") return null;
  return idealToday && idealToday > 0 ? realized / idealToday : null;
}

/** Seller productivity in the month (per weighted working day elapsed). */
export function productivityOf(
  realized: Money,
  invoices: number,
  customers: number,
  elapsed: number,
) {
  return {
    revenuePerWorkday: elapsed > 0 ? round2(realized / elapsed) : null,
    invoicesPerWorkday: elapsed > 0 ? round2(invoices / elapsed) : null,
    customers,
    averageTicket: averageTicket(realized, invoices),
  };
}

export const averageTicket = (realized: Money, invoices: number) =>
  invoices > 0 ? round2(realized / invoices) : null;

/** Company total × sum of the listed sellers, with the reason when they differ. */
export function reconciliationOf(company: Money, sellers: Money, unassigned: Money) {
  const difference = round2(company - sellers);
  let reason: string | null = null;
  if (Math.abs(difference) > 0.009)
    reason =
      unassigned > 0 && Math.abs(difference - unassigned) <= 0.009
        ? "Notas sem vendedor associado"
        : unassigned > 0
          ? "Notas sem vendedor associado e de vendedores fora da lista"
          : "Notas de vendedores fora da lista";
  return { company: round2(company), sellers: round2(sellers), difference, reason };
}

// ---------- Targets ----------
export const emptyTargets = (): TargetSet => ({ BASE: null, ACTIVE: null, CHALLENGE: null });

export function sumTargetSets(sets: TargetSet[]): TargetSet {
  const out = emptyTargets();
  for (const lvl of LEVELS) {
    const vals = sets.map((s) => s[lvl]).filter((v): v is number => v !== null);
    out[lvl] = vals.length ? round2(vals.reduce((a, b) => a + b, 0)) : null;
  }
  return out;
}

export interface TargetRow {
  channel: string | null;
  level: TargetLevel;
  amount: Money;
}

/** Company target of a month (D1): the channel row, or the whole-company row, else the channels summed. */
export function companyTargetSet(rows: TargetRow[], channel?: Channel | string): TargetSet {
  const out = emptyTargets();
  for (const lvl of LEVELS) {
    const at = rows.filter((r) => r.level === lvl);
    if (channel) {
      const r = at.find((x) => x.channel === channel);
      out[lvl] = r ? round2(r.amount) : null;
      continue;
    }
    const whole = at.find((x) => x.channel === null);
    if (whole) {
      out[lvl] = round2(whole.amount);
      continue;
    }
    const parts = at.filter((x) => x.channel === "varejo" || x.channel === "licitacao");
    out[lvl] = parts.length ? round2(parts.reduce((s, x) => s + x.amount, 0)) : null;
  }
  return out;
}

/** Plan target: company when it exists; else the sum of the sellers; else none. */
export function resolvePlanTarget(company: TargetSet, sellers: TargetSet, level: TargetLevel) {
  if (company[level] !== null) return { target: company[level], source: "company" as const };
  if (sellers[level] !== null) return { target: sellers[level], source: "sellers" as const };
  return { target: null, source: "none" as const };
}

export function undistributed(company: TargetSet, sellers: TargetSet): TargetSet {
  const out = emptyTargets();
  for (const lvl of LEVELS) {
    const c = company[lvl];
    out[lvl] = c === null ? null : round2(c - (sellers[lvl] ?? 0));
  }
  return out;
}

/** Suggestion = average of the last 3 months, rounded to R$ 1,000. */
export const suggestion = (last3: Money[]) =>
  last3.length ? Math.round(last3.reduce((a, b) => a + b, 0) / last3.length / 1000) * 1000 : null;

// ---------- Timeline and weeks ----------
export function buildTimeline(
  calendar: CalendarDay[],
  daily: Map<string, Money>,
  m: Metrics,
  today: string,
): TimelinePoint[] {
  let realizedCum = 0;
  let weightCum = 0;
  const total = m.workdaysTotal;
  const extra = m.forecastProbable !== null ? m.forecastProbable - m.realized : 0;
  const remaining = m.workdaysRemaining;
  return calendar.map((d) => {
    weightCum += d.weight;
    const past = d.date <= today;
    if (past) realizedCum += daily.get(d.date) ?? 0;
    const afterWeights = round2(weightCum - m.workdaysElapsed);
    return {
      date: d.date,
      weight: d.weight,
      revenue: past ? round2(daily.get(d.date) ?? 0) : null,
      realizedCumulative: past ? round2(realizedCum) : null,
      idealCumulative:
        m.target === null || total === 0 ? null : round2((m.target * weightCum) / total),
      projection:
        d.date >= today && m.currentDailyPace !== null
          ? round2(m.realized + m.currentDailyPace * Math.max(0, afterWeights))
          : null,
      forecast:
        d.date >= today && m.forecastProbable !== null
          ? round2(
              m.realized +
                (remaining > 0 ? (extra * Math.max(0, afterWeights)) / remaining : extra),
            )
          : null,
      isToday: d.date === today,
    };
  });
}

export function buildWeeks(
  calendar: CalendarDay[],
  daily: Map<string, Money>,
  previousDaily: Map<string, Money>,
  previousCalendar: CalendarDay[],
  target: Money | null,
  today: string,
  cfg: FlightPlanConfig = DEFAULT_FLIGHT_PLAN_CONFIG,
): WeekPace[] {
  const total = sumWeights(calendar);
  const groups = new Map<string, CalendarDay[]>();
  for (const d of calendar) {
    const k = mondayOf(d.date);
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const prevGroups = new Map<number, CalendarDay[]>();
  let pi = 0;
  let lastKey = "";
  for (const d of previousCalendar) {
    const k = mondayOf(d.date);
    if (k !== lastKey) {
      pi++;
      lastKey = k;
    }
    prevGroups.set(pi, [...(prevGroups.get(pi) ?? []), d]);
  }
  return [...groups.values()].map((days, idx) => {
    const start = days[0]!.date;
    const end = days[days.length - 1]!.date;
    const workdays = round2(days.reduce((s, d) => s + d.weight, 0));
    const started = start <= today;
    const realized = started
      ? round2(
          days.filter((d) => d.date <= today).reduce((s, d) => s + (daily.get(d.date) ?? 0), 0),
        )
      : null;
    const wTarget = target === null || total === 0 ? null : round2((target * workdays) / total);
    const prev = prevGroups.get(idx + 1);
    const current = start <= today && today <= end;
    let ratio: number | null = null;
    if (wTarget && realized !== null && started) {
      const elapsedW = days.filter((d) => d.date <= today).reduce((s, d) => s + d.weight, 0);
      const idealW = workdays > 0 ? (wTarget * elapsedW) / workdays : 0;
      ratio = idealW > 0 ? realized / idealW : null;
    }
    return {
      index: idx + 1,
      start,
      end,
      workdays,
      target: wTarget,
      realized,
      previousMonthSameWeek: prev
        ? round2(prev.reduce((s, d) => s + (previousDaily.get(d.date) ?? 0), 0))
        : null,
      status: statusFromRatio(ratio, cfg),
      current,
    };
  });
}

// ---------- Quarter and year ----------
export interface PeriodMonth {
  month: string;
  target: Money | null;
  realized: Money;
  workdaysRemaining: number;
}

export interface PartialPeriod {
  months: number;
  missingTarget: number;
  target: Money | null;
  realizedTotal: Money;
  realizedWithTarget: Money;
  attainment: number | null;
  requiredDailyPace: Money | null;
  workdaysRemaining: number;
}

/** Quarter/year: % and pace compare only the months that have a target (accumulated target). */
export function partialPeriod(rows: PeriodMonth[]): PartialPeriod {
  const withT = rows.filter((r) => r.target !== null);
  const target = withT.length ? round2(withT.reduce((a, r) => a + r.target!, 0)) : null;
  const realizedWithTarget = round2(withT.reduce((a, r) => a + r.realized, 0));
  const remaining = round2(withT.reduce((a, r) => a + r.workdaysRemaining, 0));
  const gap = target === null ? null : Math.max(0, target - realizedWithTarget);
  return {
    months: rows.length,
    missingTarget: rows.length - withT.length,
    target,
    realizedTotal: round2(rows.reduce((a, r) => a + r.realized, 0)),
    realizedWithTarget,
    attainment: target ? realizedWithTarget / target : null,
    requiredDailyPace: gap === null || remaining === 0 ? null : round2(gap / remaining),
    workdaysRemaining: remaining,
  };
}

export function periodSummaryOf(label: string, rows: PeriodMonth[]): PeriodSummary & PartialPeriod {
  const p = partialPeriod(rows);
  return { label, ...p, realized: p.realizedTotal };
}

/** Destino year view: month by month with accumulated values (realized is 0 after today). */
export function buildYearRows(
  rows: { month: string; target: Money | null; realized: Money }[],
): YearMonthRow[] {
  let ct = 0;
  let cr = 0;
  let anyTarget = false;
  return rows.map((r) => {
    if (r.target !== null) {
      ct += r.target;
      anyTarget = true;
    }
    cr += r.realized;
    return {
      month: r.month,
      target: r.target,
      realized: round2(r.realized),
      attainment: r.target ? r.realized / r.target : null,
      cumulativeTarget: anyTarget ? round2(ct) : null,
      cumulativeRealized: round2(cr),
    };
  });
}

// ---------- Quotes (D4: listed apart, never in the forecast) ----------
export function openQuotesSummary(quotes: { amount: Money; openedAt: string }[], today: string) {
  return {
    count: quotes.length,
    amount: round2(quotes.reduce((s, q) => s + q.amount, 0)),
    avgAgeDays: quotes.length
      ? Math.round(quotes.reduce((s, q) => s + diffDays(today, q.openedAt), 0) / quotes.length)
      : null,
  };
}

// ---------- Weekly review ----------
export interface SnapshotPoint {
  date: string;
  realized: Money;
  forecastProbable: Money | null;
}
/** Change between two daily snapshots; month-to-date values restart when the month changes. */
export function weeklyChange(from: SnapshotPoint | null, to: SnapshotPoint | null) {
  if (!to) return { realizedChange: 0, forecastChange: null };
  const sameMonth = !!from && from.date.slice(0, 7) === to.date.slice(0, 7);
  const base = sameMonth ? from!.realized : 0;
  return {
    realizedChange: round2(to.realized - base),
    forecastChange:
      sameMonth && from!.forecastProbable !== null && to.forecastProbable !== null
        ? round2(to.forecastProbable - from!.forecastProbable)
        : null,
  };
}

// ---------- Route coverage ----------
export function planCoverage(gap: Money | null, planned: Money) {
  if (gap === null) return { coverage: null, uncovered: null };
  if (gap <= 0) return { coverage: null, uncovered: 0 };
  return { coverage: planned / gap, uncovered: round2(Math.max(0, gap - planned)) };
}

// ---------- Quote conversion ----------
export interface ConversionFacts {
  tracked: number;
  trackedAmount: Money;
  converted: number;
  convertedAmount: Money;
  lost: number;
  lostAmount: Money;
}

/** "forming" until the stage history covers minDays and minResolved resolved quotes. */
export function conversionStatus(f: ConversionFacts, today: string, cfg: FlightPlanConfig) {
  const since = cfg.conversion.since ?? today;
  const resolved = f.converted + f.lost;
  const ready =
    diffDays(today, since) >= cfg.conversion.minDays && resolved >= cfg.conversion.minResolved;
  const amountResolved = f.convertedAmount + f.lostAmount;
  return {
    status: ready ? ("ready" as const) : ("forming" as const),
    since,
    quotes: f.tracked,
    converted: f.converted,
    lost: f.lost,
    rateCount: ready && resolved > 0 ? f.converted / resolved : null,
    rateAmount: ready && amountResolved > 0 ? f.convertedAmount / amountResolved : null,
  };
}

// ---------- Alerts ----------
export interface AlertSubject {
  sellerId: string | null; // null = the aggregate of the scope (company, channel or team)
  name: string;
  metrics: Metrics;
  hasTarget: boolean;
  plannedAmount: Money;
  lateOrders: { amount: Money; overdueDays: number }[];
  staleQuotes: { amount: Money; ageDays: number }[];
  idleWorkdays: number | null;
  statusLastMonday: FlightStatus | null;
}

export type ComputedAlert = Omit<
  Alert,
  "state" | "reopened" | "initiativeId" | "note" | "updatedAt"
> & {
  /** Who the alert is about: the seller id, or the aggregate subject of the reading scope. */
  subject: string;
};

const brl = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const pct = (v: number) => (v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + "%";

export function computeAlerts(
  ctx: {
    companyId: string;
    month: string;
    noTarget: boolean;
    calendarMissingYear: number | null;
    /** Key of the aggregate subject ("empresa" for the whole company). */
    aggregateSubject?: string;
  },
  subjects: AlertSubject[],
  cfg: FlightPlanConfig = DEFAULT_FLIGHT_PLAN_CONFIG,
): ComputedAlert[] {
  const a = cfg.alerts;
  const agg = ctx.aggregateSubject ?? "empresa";
  const out: ComputedAlert[] = [];
  const push = (
    type: AlertType,
    s: AlertSubject | null,
    priority: 1 | 2 | 3,
    message: string,
    evidence: string,
  ) => {
    const subject = s?.sellerId ?? agg;
    out.push({
      key: `${type}:${ctx.companyId}:${subject}:${ctx.month}`,
      type,
      priority,
      sellerId: s?.sellerId ?? null,
      message,
      evidence,
      subject,
    });
  };

  if (ctx.noTarget)
    push(
      "NO_TARGET",
      null,
      1,
      "Mês sem meta: nenhum pilar tem referência.",
      "Meta da empresa e dos vendedores vazias",
    );
  if (ctx.calendarMissingYear !== null)
    push(
      "NO_CALENDAR",
      null,
      3,
      `Calendário de ${ctx.calendarMissingYear} sem feriados.`,
      `0 feriados cadastrados para ${ctx.calendarMissingYear}`,
    );

  for (const s of subjects) {
    const m = s.metrics;
    const who = s.sellerId ? s.name : "Empresa";
    if (
      s.hasTarget &&
      m.status &&
      m.status !== "ON_TRACK" &&
      m.deviation !== null &&
      m.deviation < 0
    )
      push(
        "BELOW_FLIGHT_LINE",
        s,
        m.status === "CRITICAL" ? 1 : 2,
        `${who} abaixo da linha de voo.`,
        `Realizado ${brl(m.realized)} contra ideal ${brl(m.idealToday ?? 0)} (desvio ${brl(m.deviation)})`,
      );
    if (s.hasTarget && m.remainingGap && m.remainingGap > 0 && m.workdaysRemaining > 0) {
      const cover = (m.portfolioWeighted + s.plannedAmount) / m.remainingGap;
      if (cover < a.lowCoverage && s.sellerId === null)
        push(
          "LOW_COVERAGE",
          s,
          1,
          "Carteira e plano cobrem menos da metade do que falta.",
          `Carteira ponderada ${brl(m.portfolioWeighted)} + plano ${brl(s.plannedAmount)} = ${pct(cover)} do gap de ${brl(m.remainingGap)}`,
        );
    }
    if (
      s.hasTarget &&
      m.requiredDailyPace !== null &&
      m.currentDailyPace &&
      m.currentDailyPace > 0 &&
      m.requiredDailyPace > m.currentDailyPace * (1 + a.paceAcceleration) &&
      s.sellerId === null
    )
      push(
        "PACE_ACCELERATION",
        s,
        2,
        "Ritmo necessário bem acima do atual.",
        `${brl(m.requiredDailyPace)}/dia necessários contra ${brl(m.currentDailyPace)}/dia (+${pct(m.requiredDailyPace / m.currentDailyPace - 1)})`,
      );
    if (s.hasTarget && m.gapUnreachable)
      push(
        "GAP_UNREACHABLE",
        s,
        1,
        `${who}: meta inalcançável no mês.`,
        `Faltam ${brl(m.remainingGap ?? 0)} e não há dias úteis restantes`,
      );
    if (s.lateOrders.length && s.sellerId === null) {
      const total = s.lateOrders.reduce((acc, o) => acc + o.amount, 0);
      const days = s.lateOrders.map((o) => o.overdueDays);
      push(
        "LATE_ORDERS",
        s,
        1,
        "Pedidos com previsão de faturamento vencida.",
        `${s.lateOrders.length} pedidos, ${brl(total)}, previsão vencida há ${Math.min(...days)} a ${Math.max(...days)} dias`,
      );
    }
    const stale = s.staleQuotes.filter((q) => q.ageDays > a.staleQuoteDays);
    if (stale.length && s.sellerId !== null)
      push(
        "STALE_QUOTES",
        s,
        3,
        `${who}: orçamentos parados há mais de ${a.staleQuoteDays} dias.`,
        `${stale.length} orçamentos, ${brl(stale.reduce((acc, q) => acc + q.amount, 0))}, o mais antigo com ${Math.max(...stale.map((q) => q.ageDays))} dias`,
      );
    if (
      s.sellerId !== null &&
      s.hasTarget &&
      s.idleWorkdays !== null &&
      s.idleWorkdays >= a.idleSellerWorkdays
    )
      push(
        "SELLER_IDLE",
        s,
        2,
        `${who} sem nota há ${s.idleWorkdays} dias úteis.`,
        `Última nota há ${s.idleWorkdays} dias úteis, com meta no mês`,
      );
    if (m.status && s.statusLastMonday && STATUS_RANK[m.status] > STATUS_RANK[s.statusLastMonday])
      push(
        "STATUS_WORSENED",
        s,
        2,
        `${who}: status piorou desde segunda.`,
        `${STATUS_LABEL[s.statusLastMonday]} → ${STATUS_LABEL[m.status]}`,
      );
  }
  return out.sort((x, y) => x.priority - y.priority || x.key.localeCompare(y.key));
}

/** Working days (weight > 0) between the last invoice and today, not counting the invoice day. */
export function idleWorkdays(
  lastInvoice: string | null,
  today: string,
  weightOf: (d: string) => number,
): number | null {
  if (!lastInvoice) return null;
  let n = 0;
  for (let d = addDays(lastInvoice, 1); d <= today; d = addDays(d, 1)) if (weightOf(d) > 0) n++;
  return n;
}

// ---------- Legacy shape (Vendedores, Vendedor 360, Vendas, daily snapshots) ----------
// Same numbers as the Plano de Voo, in the field names those screens already use.

export interface PortfolioBuckets {
  fresh: number;
  recent: number;
  aged: number;
}

export interface FlightPlanMetrics {
  target: number;
  realized: number;
  attainment: number | null;
  idealToday: number | null;
  deviation: number | null;
  remainingGap: number;
  workingDaysTotal: number;
  workingDaysElapsed: number;
  workingDaysRemaining: number;
  currentDailyPace: number | null;
  requiredDailyPace: number | null;
  /** Gap > 0 and no working days left. */
  gapUnreachable: boolean;
  runRateForecast: number | null;
  forecastBase: number | null;
  forecastProbable: number | null;
  forecastCommit: number | null;
  portfolio: number;
  portfolioWeighted: number;
  gapCoverage: number | null;
  /** Ratio used for status (realized/ideal, or realized/target when closed). */
  paceIndex: number | null;
  status: FlightStatus | null;
}

export interface LegacyTimelinePoint {
  date: string;
  working: boolean;
  revenue: number | null;
  realizedCumulative: number | null;
  idealCumulative: number;
  projection: number | null;
  forecast: number | null;
  isToday: boolean;
}

export function toLegacyMetrics(m: Metrics, state: PeriodState): FlightPlanMetrics {
  return {
    target: m.target ?? 0,
    realized: m.realized,
    attainment: m.attainment,
    idealToday: m.idealToday,
    deviation: m.deviation,
    remainingGap: m.remainingGap ?? 0,
    workingDaysTotal: m.workdaysTotal,
    workingDaysElapsed: m.workdaysElapsed,
    workingDaysRemaining: m.workdaysRemaining,
    currentDailyPace: m.currentDailyPace,
    requiredDailyPace: m.requiredDailyPace,
    gapUnreachable: m.gapUnreachable,
    runRateForecast: m.runRateForecast,
    forecastBase: m.forecastBase,
    forecastProbable: m.forecastProbable,
    forecastCommit: m.forecastCommit,
    portfolio: m.portfolio,
    portfolioWeighted: m.portfolioWeighted,
    gapCoverage: m.gapCoverage,
    paceIndex: paceRatio(m.target, m.realized, m.idealToday, state),
    status: m.status,
  };
}

export function toLegacyTimeline(points: TimelinePoint[]): LegacyTimelinePoint[] {
  return points.map((p) => ({
    date: p.date,
    working: p.weight > 0,
    revenue: p.revenue,
    realizedCumulative: p.realizedCumulative,
    idealCumulative: p.idealCumulative ?? 0,
    projection: p.projection,
    forecast: p.forecast,
    isToday: p.isToday,
  }));
}

export type ActionType =
  | "BELOW_FLIGHT_LINE"
  | "GAP_OPEN"
  | "LOW_COVERAGE"
  | "PACE_ACCELERATION"
  | "NEW_PIPELINE"
  | "GAP_UNREACHABLE";

export interface ActionSuggestion {
  type: ActionType;
  priority: 1 | 2 | 3;
  message: string;
}

const PRIORITY_BY_STATUS: Record<FlightStatus, 1 | 2 | 3> = {
  CRITICAL: 1,
  RISK: 1,
  ATTENTION: 2,
  ON_TRACK: 3,
};

/** Vendedor 360 actions. Rules only fire for the current period; closed/future months need no action. */
export function deriveActions(
  m: FlightPlanMetrics,
  state: PeriodState,
  cfg: FlightPlanConfig,
): ActionSuggestion[] {
  if (state !== "current" || m.target <= 0 || m.remainingGap <= 0) return [];
  const base = m.status ? PRIORITY_BY_STATUS[m.status] : 3;
  const out: ActionSuggestion[] = [];
  if (m.gapUnreachable) {
    out.push({
      type: "GAP_UNREACHABLE",
      priority: 1,
      message: `Sem dias úteis restantes e gap de ${brl(m.remainingGap)}.`,
    });
    return out;
  }
  if (m.deviation != null && m.deviation < 0 && m.status && m.status !== "ON_TRACK")
    out.push({
      type: "BELOW_FLIGHT_LINE",
      priority: base,
      message: `Abaixo da linha de voo em ${brl(-m.deviation)}.`,
    });
  if (m.status && m.status !== "ON_TRACK")
    out.push({
      type: "GAP_OPEN",
      priority: base,
      message: `Gap de ${brl(m.remainingGap)} para a meta.`,
    });
  if (m.gapCoverage != null && m.gapCoverage < 1)
    out.push({
      type: "LOW_COVERAGE",
      priority: m.gapCoverage < 0.5 ? 1 : 2,
      message: `Carteira ponderada cobre apenas ${pct(m.gapCoverage)} do gap.`,
    });
  if (m.currentDailyPace && m.requiredDailyPace != null) {
    const accel = m.requiredDailyPace / m.currentDailyPace - 1;
    if (accel > cfg.accelerationAlert)
      out.push({
        type: "PACE_ACCELERATION",
        priority: accel > 0.5 ? 1 : 2,
        message: `Ritmo necessário está ${pct(accel)} acima do ritmo atual.`,
      });
  }
  if (m.gapCoverage != null && m.gapCoverage < 0.5)
    out.push({
      type: "NEW_PIPELINE",
      priority: 2,
      message: "Necessário gerar novas oportunidades.",
    });
  return out.sort((x, y) => x.priority - y.priority);
}
