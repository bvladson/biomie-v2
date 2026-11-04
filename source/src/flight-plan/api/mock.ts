/**
 * Implementação em memória da FlightPlanApi (somente protótipo).
 * Latência de 300 a 600 ms e erro simulado ocasional nas leituras.
 * Na produção, este arquivo é substituído por um adapter ligado ao banco real.
 */
import type {
  Alert,
  AlertState,
  AppRole,
  Channel,
  Company,
  FlightPlan,
  FlightPlanApi,
  Indicators,
  Initiative,
  InitiativeInput,
  InitiativeStatus,
  Me,
  Money,
  PlanQuery,
  Seller,
  SellerRow,
  Snapshot,
  TargetChange,
  TargetLevel,
  TargetList,
  TargetPreview,
  TargetSet,
  TargetsMonth,
  WeeklyReview,
  YearMonthRow,
  FlightStatus,
  Comparison,
  HistoryEvent,
  PeriodMonthRow,
} from "./contract";
import {
  AS_OF,
  COMPANIES,
  CONVERSION_SINCE,
  HOLIDAYS,
  SNAPSHOTS_SINCE,
  buildDataset,
  yearHasHolidays,
  type Dataset,
  type TargetRow,
} from "../mock/data";
import {
  buildCalendar,
  buildTimeline,
  buildWeeks,
  classifyOrder,
  computeAlerts,
  computeMetrics,
  dayWeight,
  emptyTargets,
  idleWorkdays,
  planCoverage,
  resolvePlanTarget,
  round2,
  sumTargetSets,
  sumWeights,
  suggestion,
  undistributed,
  type AlertSubject,
  type OpenOrder,
  periodState,
  periodSummaryOf,
  remainingWorkdays,
  buildYearRows,
} from "../mock/engine";
import {
  addDays,
  addMonths,
  diffDays,
  mondayOf,
  monthEnd,
  monthOf,
  quarterMonths,
  weekday,
  yearMonths,
} from "../lib/dates";

// ---------- Sessão simulada ("Entrar como") ----------
export type Persona = "ADMIN" | "DIRETORIA" | "GESTOR" | "VENDEDOR";
const ALL = COMPANIES.map((c) => c.id);
const GESTOR_TEAM = [
  "mag-filial-v01",
  "mag-filial-v02",
  "mag-filial-v03",
  "mag-filial-v04",
  "mag-filial-v05",
];
export const PERSONAS: Record<Persona, Me> = {
  ADMIN: {
    userId: "u-admin",
    name: "Admin Grupo",
    roles: ["ADMIN"],
    companyIds: ALL,
    sellerId: null,
    managedSellerIds: [],
  },
  DIRETORIA: {
    userId: "u-diretoria",
    name: "Diretoria Comercial",
    roles: ["DIRETORIA"],
    companyIds: ALL,
    sellerId: null,
    managedSellerIds: [],
  },
  GESTOR: {
    userId: "u-gestor",
    name: "Gestor Mag Filial",
    roles: ["GESTOR"],
    companyIds: ["mag-filial"],
    sellerId: null,
    managedSellerIds: GESTOR_TEAM,
  },
  VENDEDOR: {
    userId: "user-mag-filial-v02",
    name: "Bruno Gomes",
    roles: ["VENDEDOR"],
    companyIds: ["mag-filial"],
    sellerId: "mag-filial-v02",
    managedSellerIds: [],
  },
};

// ---------- Auditoria simulada (auxiliar do protótipo, fora do contrato) ----------
export type AuditEvent = HistoryEvent;

type Listener = () => void;

export function createMockFlightPlan(
  options: { latency?: [number, number]; errorRate?: number } = {},
) {
  const latency = options.latency ?? [300, 600];
  let errorRate = options.errorRate ?? 0.02;
  let persona: Persona = "ADMIN";
  let failNext = false;
  const ds: Dataset = buildDataset();
  const audit: AuditEvent[] = [];
  const listeners = new Set<Listener>();
  const commits = new Map<string, { amount: Money; note: string | null; updatedAt: string }>([
    [
      "mag-filial-v01:2026-11",
      {
        amount: 125_000,
        note: "Fecha Construtora Litoral até dia 25",
        updatedAt: "2026-11-16T14:20:00Z",
      },
    ],
    ["mag-filial-v02:2026-11", { amount: 88_000, note: null, updatedAt: "2026-11-17T11:05:00Z" }],
  ]);
  const initiatives: Initiative[] = [
    seedInit(
      "i1",
      "Converter orçamentos acima de R$ 20 mil",
      "CONVERT_QUOTES",
      "user:u-gestor",
      "Gestor Mag Filial",
      ["mag-filial-v01", "mag-filial-v02"],
      "2026-11-25",
      90_000,
      "IN_PROGRESS",
    ),
    seedInit(
      "i2",
      "Reativar clientes de 2026 sem compra há 90 dias",
      "REACTIVATE_CUSTOMERS",
      "seller:mag-filial-v03",
      "Carla Oliveira",
      ["mag-filial-v03"],
      "2026-11-14",
      25_000,
      "PLANNED",
    ),
    seedInit(
      "i3",
      "Licitação Prefeitura de Caucaia",
      "PUBLIC_BIDS",
      "seller:mag-filial-v12",
      "Lucas Holanda",
      ["mag-filial-v12"],
      "2026-11-12",
      38_000,
      "DONE",
      41_200,
    ),
  ];
  const alertStates = new Map<
    string,
    {
      state: AlertState;
      note: string | null;
      initiativeId: string | null;
      updatedAt: string;
      evidence: string;
    }
  >();
  const firstSeen = new Map<string, string>();
  const decisions = new Map<string, { id: string; at: string; authorName: string; text: string }[]>(
    [
      [
        "mag-filial:2026-11-09",
        [
          {
            id: "d1",
            at: "2026-11-09T12:00:00Z",
            authorName: "Gestor Mag Filial",
            text: "Priorizar faturamento dos pedidos vencidos antes de novos orçamentos.",
          },
        ],
      ],
    ],
  );

  function seedInit(
    id: string,
    title: string,
    lever: Initiative["lever"],
    ownerUserId: string,
    ownerName: string,
    sellerIds: string[],
    dueDate: string,
    expectedAmount: number,
    status: InitiativeStatus,
    realizedAmount: number | null = null,
  ): Initiative {
    return {
      id,
      companyId: "mag-filial",
      month: "2026-11",
      title,
      lever,
      ownerUserId,
      ownerName,
      sellerIds,
      dueDate,
      expectedAmount,
      realizedAmount,
      status,
      alertKey: null,
      targetListKind: null,
      notes: null,
      createdAt: "2026-11-03T10:00:00Z",
      updatedAt: status === "DONE" ? "2026-11-12T17:00:00Z" : "2026-11-03T10:00:00Z",
    };
  }

  const wait = () =>
    new Promise((r) => setTimeout(r, latency[0] + Math.random() * (latency[1] - latency[0])));
  async function read<T>(fn: () => T): Promise<T> {
    await wait();
    if (failNext || Math.random() < errorRate) {
      failNext = false;
      throw new Error("Falha simulada ao carregar os dados. Tente novamente.");
    }
    return structuredClone(fn());
  }
  async function write<T>(fn: () => T): Promise<T> {
    await wait();
    return structuredClone(fn());
  }
  const me = () => PERSONAS[persona];
  const role = (r: AppRole) => me().roles.includes(r);
  const broad = () => role("ADMIN") || role("DIRETORIA") || role("SUPER_ADMIN");
  const nowIso = () => new Date().toISOString();
  function log(e: Omit<AuditEvent, "id" | "at" | "author">) {
    audit.unshift({ ...e, id: `a${audit.length + 1}`, at: nowIso(), author: me().name });
    listeners.forEach((l) => l());
  }
  const company = (id: string): Company => {
    const c = COMPANIES.find((x) => x.id === id);
    if (!c || !me().companyIds.includes(id)) throw new Error("Empresa fora do seu acesso.");
    return c;
  };
  const sellersOf = (companyId: string) => ds.sellers.filter((s) => s.companyId === companyId);
  function visibleSellers(companyId: string): Seller[] {
    const all = sellersOf(companyId);
    const m = me();
    if (m.sellerId) return all.filter((s) => s.id === m.sellerId);
    if (role("GESTOR") && !broad()) return all.filter((s) => m.managedSellerIds.includes(s.id));
    return all;
  }
  function scope(q: PlanQuery) {
    let list = visibleSellers(q.companyId);
    if (q.channel) list = list.filter((s) => s.channel === q.channel);
    if (q.sellerId) list = list.filter((s) => s.id === q.sellerId);
    const full = broad() && !q.sellerId;
    return { sellers: list, ids: new Set(list.map((s) => s.id)), full };
  }
  const weightFn = (c: Company) => (d: string) => dayWeight(d, c.saturdayWeight, HOLIDAYS);

  // ----- metas -----
  const rowsFor = (companyId: string, month: string) =>
    ds.targets.filter((t) => t.companyId === companyId && t.month === month);
  function companyTargets(companyId: string, month: string, channel?: Channel): TargetSet {
    const rows = rowsFor(companyId, month).filter((t) => t.sellerId === null);
    if (channel) return rows.find((r) => r.channel === channel)?.targets ?? emptyTargets();
    const whole = rows.find((r) => r.channel === null);
    if (whole) return whole.targets;
    return sumTargetSets(rows.map((r) => r.targets));
  }
  const sellerTarget = (companyId: string, month: string, sellerId: string) =>
    rowsFor(companyId, month).find((t) => t.sellerId === sellerId)?.targets ?? emptyTargets();
  function planTarget(
    q: PlanQuery,
    month: string,
    ids: Set<string>,
    full: boolean,
    level: TargetLevel = "ACTIVE",
  ) {
    const sellersSum = sumTargetSets([...ids].map((id) => sellerTarget(q.companyId, month, id)));
    return resolvePlanTarget(
      full ? companyTargets(q.companyId, month, q.channel) : emptyTargets(),
      sellersSum,
      level,
    );
  }

  // ----- fatos -----
  const invoicesIn = (companyId: string, ids: Set<string>, from: string, to: string) =>
    ds.invoices.filter(
      (i) => i.companyId === companyId && ids.has(i.sellerId) && i.date >= from && i.date <= to,
    );
  const sum = (xs: { amount: number }[]) => round2(xs.reduce((s, x) => s + x.amount, 0));
  function dailyMap(companyId: string, ids: Set<string>, month: string, upTo: string) {
    const m = new Map<string, number>();
    for (const i of invoicesIn(
      companyId,
      ids,
      `${month}-01`,
      upTo < monthEnd(month) ? upTo : monthEnd(month),
    ))
      m.set(i.date, (m.get(i.date) ?? 0) + i.amount);
    return m;
  }
  const ordersOf = (companyId: string, ids: Set<string>, asOf: string): OpenOrder[] =>
    ds.orders.filter((o) => o.companyId === companyId && ids.has(o.sellerId) && o.openedAt <= asOf);
  const firstPurchase = (() => {
    const m = new Map<string, string>();
    for (const i of ds.invoices) if (!m.has(i.customerId)) m.set(i.customerId, i.date);
    return m;
  })();

  function comparison(
    companyId: string,
    ids: Set<string>,
    month: string,
    today: string,
  ): Comparison {
    const state = periodState(month, today);
    const day = Number((state === "current" ? today : monthEnd(month)).slice(8));
    const cut = (m: string) => {
      const last = monthEnd(m);
      const d = `${m}-${String(Math.min(day, Number(last.slice(8)))).padStart(2, "0")}`;
      return sum(invoicesIn(companyId, ids, `${m}-01`, state === "current" ? d : last));
    };
    const prev3 = [1, 2, 3].map((n) =>
      sum(invoicesIn(companyId, ids, `${addMonths(month, -n)}-01`, monthEnd(addMonths(month, -n)))),
    );
    return {
      previousMonthSameCut: cut(addMonths(month, -1)),
      previousYearSameCut: cut(addMonths(month, -12)),
      last3MonthsAvg: round2(prev3.reduce((a, b) => a + b, 0) / 3),
    };
  }

  function metricsFor(q: PlanQuery, month: string, ids: Set<string>, full: boolean, today: string) {
    const c = company(q.companyId);
    const calendar = buildCalendar(month, c.saturdayWeight, HOLIDAYS);
    const { target, source } = planTarget(q, month, ids, full);
    const daily = dailyMap(q.companyId, ids, month, today);
    const realized = [...daily.values()].reduce((a, b) => a + b, 0);
    const commitVals = [...ids]
      .map((id) => commits.get(`${id}:${month}`)?.amount)
      .filter((v): v is number => v !== undefined);
    const metrics = computeMetrics({
      target,
      realized,
      calendar,
      today,
      month,
      orders: ordersOf(q.companyId, ids, today),
      commits: commitVals,
    });
    return { metrics, calendar, daily, source };
  }

  function monthRows(
    q: PlanQuery,
    year: number,
    ids: Set<string>,
    full: boolean,
  ): PeriodMonthRow[] {
    const c = company(q.companyId);
    return yearMonths(year).map((m) => ({
      month: m,
      target: planTarget(q, m, ids, full).target,
      realized:
        m > monthOf(AS_OF)
          ? 0
          : sum(invoicesIn(q.companyId, ids, `${m}-01`, monthEnd(m) < AS_OF ? monthEnd(m) : AS_OF)),
      workdaysRemaining: remainingWorkdays(buildCalendar(m, c.saturdayWeight, HOLIDAYS), m, AS_OF),
    }));
  }

  function getPlanSync(q: PlanQuery): FlightPlan {
    const c = company(q.companyId);
    const today = c.asOf;
    const sc = scope(q);
    const { metrics, calendar, daily, source } = metricsFor(q, q.month, sc.ids, sc.full, today);
    const end = monthEnd(q.month);
    const monthInvoices = invoicesIn(
      q.companyId,
      sc.ids,
      `${q.month}-01`,
      today < end ? today : end,
    );
    const customers = new Set(monthInvoices.map((i) => i.customerId));
    const newCustomers = [...customers].filter(
      (id) => monthOf(firstPurchase.get(id)!) === q.month,
    ).length;
    const quotes = ds.quotes.filter((x) => x.companyId === q.companyId && sc.ids.has(x.sellerId));
    const indicators: Indicators = {
      invoices: monthInvoices.length,
      averageTicket: monthInvoices.length ? round2(metrics.realized / monthInvoices.length) : null,
      customers: customers.size,
      newCustomers,
      recurringCustomers: customers.size - newCustomers,
      openQuotes: {
        count: quotes.length,
        amount: sum(quotes),
        avgAgeDays: quotes.length
          ? Math.round(quotes.reduce((s, x) => s + diffDays(today, x.openedAt), 0) / quotes.length)
          : null,
      },
      conversion: {
        status: "forming",
        since: CONVERSION_SINCE,
        quotes: quotes.length,
        converted: 0,
        lost: 0,
        rateCount: null,
        rateAmount: null,
      },
      comparison: comparison(q.companyId, sc.ids, q.month, today),
    };
    const prevMonth = addMonths(q.month, -1);
    const prevCal = buildCalendar(prevMonth, c.saturdayWeight, HOLIDAYS);
    const sellers: SellerRow[] = sc.sellers.map((s) => {
      const one = new Set([s.id]);
      const sm = metricsFor({ ...q, sellerId: s.id }, q.month, one, false, today);
      const inv = monthInvoices.filter((i) => i.sellerId === s.id);
      const orders = ordersOf(q.companyId, one, today);
      const targets = sellerTarget(q.companyId, q.month, s.id);
      const el = sm.metrics.workdaysElapsed;
      return {
        seller: s,
        targets,
        metrics: sm.metrics,
        hasActivity: targets.ACTIVE !== null || sm.metrics.realized > 0 || orders.length > 0,
        productivity: {
          revenuePerWorkday: el > 0 ? round2(sm.metrics.realized / el) : null,
          invoicesPerWorkday: el > 0 ? round2(inv.length / el) : null,
          customers: new Set(inv.map((i) => i.customerId)).size,
          averageTicket: inv.length ? round2(sm.metrics.realized / inv.length) : null,
        },
        openOrders: orders.length,
        lateOrders: orders.filter((o) => classifyOrder(o, today, end).late).length,
        openQuotes: quotes.filter((x) => x.sellerId === s.id).length,
        commit: commits.get(`${s.id}:${q.month}`) ?? null,
        comparison: comparison(q.companyId, one, q.month, today),
      };
    });
    const sellersTotal = round2(sellers.reduce((a, r) => a + r.metrics.realized, 0));
    const year = Number(q.month.slice(0, 4));
    const months = monthRows(q, year, sc.ids, sc.full);
    return {
      query: q,
      period: { start: `${q.month}-01`, end, today, state: periodState(q.month, today) },
      activeLevel: "ACTIVE",
      targetSource: source,
      calendarMissing: !yearHasHolidays(year),
      summary: metrics,
      indicators,
      calendar,
      timeline: buildTimeline(calendar, daily, metrics, today),
      weeks: buildWeeks(
        calendar,
        daily,
        dailyMap(q.companyId, sc.ids, prevMonth, monthEnd(prevMonth)),
        prevCal,
        metrics.target,
        today,
      ),
      quarter: periodSummaryOf(
        `${Math.floor((Number(q.month.slice(5)) - 1) / 3) + 1}º trimestre ${year}`,
        months.filter((r) => quarterMonths(q.month).includes(r.month)),
      ),
      year: periodSummaryOf(`Ano ${year}`, months),
      months,
      sellers,
      reconciliation: {
        company: metrics.realized,
        sellers: sellersTotal,
        difference: round2(metrics.realized - sellersTotal),
        reason:
          Math.abs(metrics.realized - sellersTotal) > 0.009 ? "Notas sem vendedor associado" : null,
      },
    };
  }

  // ----- fotos diárias -----
  const SNAPSHOT_GAPS = new Set(["2026-10-25", "2026-11-08"]);
  function snapshotsSync(q: PlanQuery): Snapshot[] {
    const c = company(q.companyId);
    const sc = scope(q);
    const out: Snapshot[] = [];
    for (let d = SNAPSHOTS_SINCE; d <= c.asOf; d = addDays(d, 1)) {
      if (SNAPSHOT_GAPS.has(d)) continue;
      const m = monthOf(d);
      const { metrics } = metricsFor(q, m, sc.ids, sc.full, d);
      out.push({
        date: d,
        sellerId: q.sellerId ?? null,
        target: metrics.target,
        realized: metrics.realized,
        forecastProbable: metrics.forecastProbable,
        status: metrics.status,
      });
    }
    return out;
  }
  const statusAt = (q: PlanQuery, date: string): FlightStatus | null => {
    const sc = scope(q);
    return metricsFor(q, monthOf(date), sc.ids, sc.full, date).metrics.status;
  };
  const lastMonday = (today: string) =>
    weekday(today) === 1 ? addDays(today, -7) : mondayOf(today);

  // ----- iniciativas -----
  const isLate = (i: Initiative, today: string) =>
    i.dueDate < today && i.status !== "DONE" && i.status !== "CANCELLED";
  function initiativesFor(q: PlanQuery) {
    const sc = scope(q);
    return initiatives.filter(
      (i) =>
        i.companyId === q.companyId &&
        i.month === q.month &&
        (sc.full ||
          i.sellerIds.some((id) => sc.ids.has(id)) ||
          i.ownerUserId === `user:${me().userId}`),
    );
  }
  const planned = (rows: Initiative[]) =>
    round2(
      rows
        .filter((i) => i.status === "PLANNED" || i.status === "IN_PROGRESS")
        .reduce((s, i) => s + i.expectedAmount, 0),
    );
  function ownerName(owner: string) {
    const p = Object.values(PERSONAS).find((x) => `user:${x.userId}` === owner);
    if (p) return p.name;
    const s = ds.sellers.find((x) => `seller:${x.id}` === owner);
    if (s) return s.name;
    throw new Error("Responsável inválido.");
  }
  function canWriteInitiative(companyId: string, sellerIds: string[], ownerUserId: string) {
    const m = me();
    if (!m.companyIds.includes(companyId)) return false;
    if (broad()) return true;
    if (role("GESTOR")) return sellerIds.every((id) => m.managedSellerIds.includes(id));
    if (role("VENDEDOR"))
      return (
        (ownerUserId === `user:${m.userId}` || ownerUserId === `seller:${m.sellerId}`) &&
        sellerIds.every((id) => id === m.sellerId)
      );
    return false;
  }

  // ----- alertas -----
  function alertsSync(q: PlanQuery): Alert[] {
    const c = company(q.companyId);
    const today = c.asOf;
    const end = monthEnd(q.month);
    const sc = scope(q);
    const plan = getPlanSync(q);
    const inits = initiativesFor(q);
    const quotes = ds.quotes.filter((x) => x.companyId === q.companyId && sc.ids.has(x.sellerId));
    const lm = lastMonday(today);
    const wf = weightFn(c);
    const current = plan.period.state === "current";
    const subjects: AlertSubject[] = [];
    if (sc.full || !me().sellerId) {
      const late = ordersOf(q.companyId, sc.ids, today).filter(
        (o) => current && classifyOrder(o, today, end).late,
      );
      subjects.push({
        sellerId: null,
        name: c.name,
        metrics: plan.summary,
        hasTarget: plan.summary.target !== null,
        plannedAmount: planned(inits),
        lateOrders: late.map((o) => ({
          amount: o.amount,
          overdueDays: diffDays(today, o.expectedDate!),
        })),
        staleQuotes: [],
        idleWorkdays: null,
        statusLastMonday: current ? statusAt(q, lm) : null,
      });
    }
    for (const r of plan.sellers.filter((x) => x.hasActivity)) {
      const lastInv =
        ds.invoices.filter((i) => i.sellerId === r.seller.id && i.date <= today).at(-1)?.date ??
        null;
      subjects.push({
        sellerId: r.seller.id,
        name: r.seller.name,
        metrics: r.metrics,
        hasTarget: r.targets.ACTIVE !== null,
        plannedAmount: 0,
        lateOrders: [],
        staleQuotes: current
          ? quotes
              .filter((x) => x.sellerId === r.seller.id)
              .map((x) => ({ amount: x.amount, ageDays: diffDays(today, x.openedAt) }))
          : [],
        idleWorkdays: current ? idleWorkdays(lastInv, today, wf) : null,
        statusLastMonday: current ? statusAt({ ...q, sellerId: r.seller.id }, lm) : null,
      });
    }
    const nextYear = Number(q.month.slice(0, 4)) + 1;
    const computed = computeAlerts(
      {
        companyId: q.companyId,
        month: q.month,
        noTarget: plan.targetSource === "none",
        calendarMissingYear: !yearHasHolidays(Number(q.month.slice(0, 4)))
          ? Number(q.month.slice(0, 4))
          : !yearHasHolidays(nextYear)
            ? nextYear
            : null,
      },
      subjects,
    );
    return computed.map((a) => {
      if (!firstSeen.has(a.key)) firstSeen.set(a.key, today);
      const st = alertStates.get(a.key);
      const firstSeenAt = firstSeen.get(a.key) ?? null;
      if (!st)
        return {
          ...a,
          state: "OPEN",
          reopened: false,
          initiativeId: null,
          note: null,
          updatedAt: null,
          firstSeen: firstSeenAt,
        };
      if (st.state === "RESOLVED" && st.evidence !== a.evidence)
        return {
          ...a,
          state: "OPEN",
          reopened: true,
          initiativeId: st.initiativeId,
          note: st.note,
          updatedAt: st.updatedAt,
          firstSeen: firstSeenAt,
        };
      return {
        ...a,
        state: st.state,
        reopened: false,
        initiativeId: st.initiativeId,
        note: st.note,
        updatedAt: st.updatedAt,
        firstSeen: firstSeenAt,
      };
    });
  }
  // Semente: orçamentos parados da Carla foram resolvidos com outra evidência e voltaram.
  alertStates.set("STALE_QUOTES:mag-filial:mag-filial-v03:2026-11", {
    state: "RESOLVED",
    note: "Cliente retornou contato",
    initiativeId: null,
    updatedAt: "2026-11-10T15:00:00Z",
    evidence: "antiga",
  });

  // ---------- API ----------
  const api: FlightPlanApi = {
    me: () => read(() => me()),
    listCompanies: () => read(() => COMPANIES.filter((c) => me().companyIds.includes(c.id))),
    listSellers: (companyId) =>
      read(() => {
        company(companyId);
        return visibleSellers(companyId);
      }),
    getPlan: (q) => read(() => getPlanSync(q)),
    getSnapshots: (q) => read(() => snapshotsSync(q)),
    setCommit: (q, amount, note) =>
      write(() => {
        const m = me();
        const allowed =
          broad() ||
          m.sellerId === q.sellerId ||
          (role("GESTOR") && m.managedSellerIds.includes(q.sellerId));
        if (!allowed) throw new Error("Sem permissão para registrar o compromisso deste vendedor.");
        if (amount !== null && (amount < 0 || Math.round(amount * 100) !== amount * 100))
          throw new Error("Valor inválido.");
        const k = `${q.sellerId}:${q.month}`;
        const before = commits.get(k);
        if (amount === null) commits.delete(k);
        else commits.set(k, { amount, note, updatedAt: nowIso() });
        const s = ds.sellers.find((x) => x.id === q.sellerId)!;
        log({
          area: "visao",
          action: amount === null ? "Commit removido" : "Commit alterado",
          target: s.name,
          before: before ? String(before.amount) : null,
          after: amount === null ? null : String(amount),
        });
      }),
    getTargets: (companyId, month) => read(() => targetsMonth(companyId, month)),
    previewTargets: (companyId, month, changes) => write(() => preview(companyId, month, changes)),
    saveTargets: (companyId, month, changes) =>
      write(() => {
        company(companyId);
        for (const ch of changes) assertTargetPermission(companyId, ch);
        for (const ch of changes)
          if (
            ch.amount !== null &&
            (ch.amount < 0 ||
              Math.round(ch.amount * 100) !== Math.round(ch.amount * 100 * 1e6) / 1e6)
          )
            throw new Error("Valor de meta inválido.");
        const p = preview(companyId, month, changes);
        for (const ch of changes) applyChange(companyId, month, ch);
        for (const r of p.rows)
          log({
            area: "destino",
            action:
              r.before === null
                ? "Meta criada"
                : r.amount === null
                  ? "Meta removida"
                  : "Meta alterada",
            target: `${r.label} · ${LEVEL_PT[r.level]} · ${month}`,
            before: r.before === null ? null : String(r.before),
            after: r.amount === null ? null : String(r.amount),
          });
        return targetsMonth(companyId, month);
      }),
    getYear: (companyId, year, channel, sellerId) =>
      read(() => {
        company(companyId);
        const q: PlanQuery = { companyId, month: `${year}-01` };
        if (channel) q.channel = channel;
        if (sellerId) q.sellerId = sellerId;
        const sc = scope(q);
        const rows = monthRows(q, year, sc.ids, sc.full);
        return buildYearRows(rows).map<YearMonthRow>((r, k) => ({
          ...r,
          workdaysRemaining: rows[k]!.workdaysRemaining,
        }));
      }),
    listInitiatives: (q) =>
      read(() => {
        company(q.companyId);
        const rows = initiativesFor(q);
        const gap = getPlanSync(q).summary.remainingGap;
        const amount = planned(rows);
        const cov = planCoverage(gap, amount);
        return {
          rows,
          coverage: {
            remainingGap: gap,
            plannedAmount: amount,
            coverage: cov.coverage,
            uncovered: cov.uncovered,
            open: rows.filter((i) => i.status === "PLANNED" || i.status === "IN_PROGRESS").length,
            late: rows.filter((i) => isLate(i, AS_OF)).length,
          },
        };
      }),
    saveInitiative: (input: InitiativeInput) =>
      write(() => {
        company(input.companyId);
        if (
          !input.title.trim() ||
          !input.lever ||
          !input.ownerUserId ||
          !input.dueDate ||
          !(input.expectedAmount > 0)
        )
          throw new Error("Preencha título, alavanca, responsável, prazo e valor esperado.");
        if (
          input.dueDate < `${input.month}-01` ||
          input.dueDate > addDays(monthEnd(input.month), 30)
        )
          throw new Error("O prazo deve estar dentro do mês ou até 30 dias depois.");
        const existing = input.id ? initiatives.find((i) => i.id === input.id) : undefined;
        if (
          !canWriteInitiative(
            input.companyId,
            input.sellerIds,
            existing?.ownerUserId ?? input.ownerUserId,
          )
        )
          throw new Error("Sem permissão para esta iniciativa.");
        const name = ownerName(input.ownerUserId);
        if (existing) {
          const before = `${existing.title} · ${existing.expectedAmount}`;
          Object.assign(existing, { ...input, ownerName: name, updatedAt: nowIso() });
          log({
            area: "rota",
            action: "Iniciativa alterada",
            target: existing.title,
            before,
            after: `${existing.title} · ${existing.expectedAmount}`,
          });
          return existing;
        }
        const created: Initiative = {
          ...input,
          id: `i${initiatives.length + 1}-${Date.now()}`,
          ownerName: name,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        initiatives.push(created);
        log({
          area: input.alertKey ? "correcao" : "rota",
          action: "Iniciativa criada",
          target: created.title,
          before: null,
          after: `${created.expectedAmount}`,
        });
        return created;
      }),
    setInitiativeStatus: (id, status, realizedAmount, note) =>
      write(() => {
        const it = initiatives.find((i) => i.id === id);
        if (!it) throw new Error("Iniciativa não encontrada.");
        if (!canWriteInitiative(it.companyId, it.sellerIds, it.ownerUserId))
          throw new Error("Sem permissão para esta iniciativa.");
        if (status === "DONE" && (realizedAmount === null || realizedAmount < 0))
          throw new Error("Informe o resultado em R$ para concluir.");
        if (status === "CANCELLED" && !note?.trim())
          throw new Error("Informe o motivo do cancelamento.");
        const before = STATUS_INIT_PT[it.status];
        Object.assign(it, {
          status,
          realizedAmount: status === "DONE" ? realizedAmount : it.realizedAmount,
          notes: note ?? it.notes,
          updatedAt: nowIso(),
        });
        log({
          area: "rota",
          action: "Status da iniciativa",
          target: it.title,
          before,
          after: STATUS_INIT_PT[status] + (status === "DONE" ? ` (${realizedAmount})` : ""),
        });
        return it;
      }),
    getTargetLists: (q) => read(() => targetLists(q)),
    listAlerts: (q) => read(() => alertsSync(q)),
    setAlertState: (key, state, note, initiativeId) =>
      write(() => {
        const [, cid, sid, month] = key.split(":") as [string, string, string, string];
        company(cid);
        const m = me();
        const canManage =
          broad() || (role("GESTOR") && (sid === "empresa" || m.managedSellerIds.includes(sid)));
        const ownAction = role("VENDEDOR") && sid === m.sellerId && state === "ACTION_CREATED";
        if (!canManage && !ownAction) throw new Error("Sem permissão para alterar este alerta.");
        if (state === "ACKNOWLEDGED" && !note?.trim())
          throw new Error("A justificativa é obrigatória para marcar como ciente.");
        const current =
          alertsSync({ companyId: cid, month }).find((a) => a.key === key) ??
          alertsSync({ companyId: cid, month, sellerId: sid }).find((a) => a.key === key);
        if (!current) throw new Error("Alerta não está mais ativo.");
        const before = current.state;
        alertStates.set(key, {
          state,
          note,
          initiativeId: initiativeId ?? current.initiativeId,
          updatedAt: nowIso(),
          evidence: current.evidence,
        });
        log({
          area: "correcao",
          action: "Estado do alerta",
          target: current.message,
          before: ALERT_STATE_PT[before],
          after: ALERT_STATE_PT[state],
        });
        return {
          ...current,
          state,
          reopened: false,
          note,
          initiativeId: initiativeId ?? current.initiativeId,
          updatedAt: nowIso(),
        };
      }),
    getWeeklyReview: (q, weekStart) =>
      read(() => {
        company(q.companyId);
        const today = AS_OF;
        const weekEnd = addDays(weekStart, 6);
        const cut = weekEnd < today ? weekEnd : today;
        const snaps = snapshotsSync(q);
        const at = (d: string) => [...snaps].reverse().find((s) => s.date <= d) ?? null;
        const a = at(weekStart),
          b = at(cut);
        const sc = scope(q);
        const statusChanges = sc.sellers
          .filter((s) => sellerTarget(q.companyId, monthOf(cut), s.id).ACTIVE !== null)
          .flatMap((s) => {
            const from = statusAt({ ...q, sellerId: s.id }, weekStart);
            const to = statusAt({ ...q, sellerId: s.id }, cut);
            return from !== to ? [{ sellerId: s.id, from, to }] : [];
          });
        const alerts = alertsSync({ ...q, month: monthOf(cut) });
        const inits = initiativesFor({ ...q, month: monthOf(cut) });
        const prevWeek = addDays(weekStart, -7);
        return {
          weekStart,
          weekEnd,
          realizedChange: round2((b?.realized ?? 0) - (a?.realized ?? 0)),
          forecastChange:
            a?.forecastProbable != null && b?.forecastProbable != null
              ? round2(b.forecastProbable - a.forecastProbable)
              : null,
          statusChanges,
          newAlerts: alerts.filter((x) => {
            const f = firstSeen.get(x.key);
            return f !== undefined && f >= weekStart && f <= weekEnd;
          }),
          lateInitiatives: inits.filter((i) => isLate(i, cut)),
          doneInitiatives: inits.filter(
            (i) =>
              i.status === "DONE" &&
              i.updatedAt.slice(0, 10) >= weekStart &&
              i.updatedAt.slice(0, 10) <= weekEnd,
          ),
          decisions: [
            ...(decisions.get(`${q.companyId}:${weekStart}`) ?? []),
            ...(decisions.get(`${q.companyId}:${prevWeek}`) ?? []).map((d) => ({
              ...d,
              text: `(semana anterior) ${d.text}`,
            })),
          ],
        } satisfies WeeklyReview;
      }),
    listHistory: (companyId, area) =>
      read(() => {
        company(companyId);
        return area ? audit.filter((e) => e.area === area) : [...audit];
      }),
    addDecision: (q, weekStart, text) =>
      write(() => {
        company(q.companyId);
        if (!(broad() || role("GESTOR")))
          throw new Error("Só Admin, Diretoria e Gestor registram decisões.");
        if (!text.trim()) throw new Error("Escreva a decisão.");
        const k = `${q.companyId}:${weekStart}`;
        decisions.set(k, [
          ...(decisions.get(k) ?? []),
          { id: `d${Date.now()}`, at: nowIso(), authorName: me().name, text: text.trim() },
        ]);
        log({
          area: "correcao",
          action: "Decisão registrada",
          target: `Semana de ${weekStart}`,
          before: null,
          after: text.trim(),
        });
      }),
  };

  // ----- metas: leitura e gravação -----
  function targetsMonth(companyId: string, month: string): TargetsMonth {
    company(companyId);
    const m = me();
    const canEditCompany = broad();
    const companyRows: TargetsMonth["company"] = (["varejo", "licitacao"] as Channel[]).map(
      (ch) => ({ channel: ch, targets: companyTargets(companyId, month, ch) }),
    );
    const whole = rowsFor(companyId, month).find((r) => r.sellerId === null && r.channel === null);
    if (whole) companyRows.push({ channel: null, targets: whole.targets });
    const visible = visibleSellers(companyId).filter(
      (s) => s.active || sellerTarget(companyId, month, s.id).ACTIVE !== null,
    );
    const sellers = visible.map((s) => {
      const last3 = [1, 2, 3].map((n) =>
        sum(
          invoicesIn(
            companyId,
            new Set([s.id]),
            `${addMonths(month, -n)}-01`,
            monthEnd(addMonths(month, -n)),
          ),
        ),
      );
      return {
        seller: s,
        targets: sellerTarget(companyId, month, s.id),
        previousMonth: sellerTarget(companyId, addMonths(month, -1), s.id),
        suggestion: last3.some((v) => v > 0) ? suggestion(last3) : null,
        editable: broad() || (role("GESTOR") && m.managedSellerIds.includes(s.id)),
      };
    });
    const allSellerSum = sumTargetSets(
      sellersOf(companyId).map((s) => sellerTarget(companyId, month, s.id)),
    );
    const anyEdit = canEditCompany || sellers.some((s) => s.editable);
    return {
      companyId,
      month,
      activeLevel: "ACTIVE",
      company: companyRows,
      sellers,
      undistributed: undistributed(companyTargets(companyId, month), allSellerSum),
      canEditCompany,
      readOnlyReason: anyEdit ? null : "Somente leitura: metas são definidas pela gestão",
    };
  }
  function assertTargetPermission(companyId: string, ch: TargetChange) {
    if (ch.scope === "company") {
      if (!broad()) throw new Error("Só Admin e Diretoria editam a meta da empresa.");
      return;
    }
    const sid = ch.sellerId;
    if (!sid || !sellersOf(companyId).some((s) => s.id === sid))
      throw new Error("Vendedor inválido.");
    if (broad()) return;
    if (role("GESTOR") && me().managedSellerIds.includes(sid)) return;
    throw new Error("Sem permissão para alterar a meta deste vendedor.");
  }
  function currentValue(companyId: string, month: string, ch: TargetChange): Money | null {
    const row = findRow(companyId, month, ch);
    return row ? row.targets[ch.level] : null;
  }
  function findRow(companyId: string, month: string, ch: TargetChange): TargetRow | undefined {
    return ds.targets.find(
      (t) =>
        t.companyId === companyId &&
        t.month === month &&
        (ch.scope === "company"
          ? t.sellerId === null && t.channel === (ch.channel ?? null)
          : t.sellerId === ch.sellerId),
    );
  }
  function labelOf(ch: TargetChange) {
    if (ch.scope === "company")
      return ch.channel === "varejo"
        ? "Empresa · Varejo"
        : ch.channel === "licitacao"
          ? "Empresa · Licitação"
          : "Empresa";
    return ds.sellers.find((s) => s.id === ch.sellerId)?.name ?? "Vendedor";
  }
  function preview(companyId: string, month: string, changes: TargetChange[]): TargetPreview {
    company(companyId);
    let created = 0,
      updated = 0,
      removed = 0;
    const rows: TargetPreview["rows"] = [];
    for (const ch of changes) {
      const before = currentValue(companyId, month, ch);
      if (before === ch.amount) continue;
      if (before === null) created++;
      else if (ch.amount === null) removed++;
      else updated++;
      rows.push({ ...ch, label: labelOf(ch), before });
    }
    return { created, updated, removed, rows };
  }
  function applyChange(companyId: string, month: string, ch: TargetChange) {
    let row = findRow(companyId, month, ch);
    if (!row) {
      if (ch.amount === null) return;
      row = {
        companyId,
        month,
        channel: ch.scope === "company" ? (ch.channel ?? null) : null,
        sellerId: ch.scope === "seller" ? ch.sellerId! : null,
        targets: emptyTargets(),
      };
      ds.targets.push(row);
    }
    row.targets = { ...row.targets, [ch.level]: ch.amount };
    if (row.targets.BASE === null && row.targets.ACTIVE === null && row.targets.CHALLENGE === null)
      ds.targets.splice(ds.targets.indexOf(row), 1);
  }

  function targetLists(q: PlanQuery): TargetList[] {
    const c = company(q.companyId);
    const today = c.asOf,
      end = monthEnd(q.month);
    const sc = scope(q);
    const name = (id: string) => ds.sellers.find((s) => s.id === id)?.name ?? "";
    const quotes = ds.quotes
      .filter((x) => x.companyId === q.companyId && sc.ids.has(x.sellerId))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    const late = ordersOf(q.companyId, sc.ids, today).filter(
      (o) => classifyOrder(o, today, end).late,
    );
    const year = today.slice(0, 4);
    const lastBuy = new Map<string, { date: string; sellerId: string; total: number }>();
    for (const i of ds.invoices)
      if (
        i.companyId === q.companyId &&
        sc.ids.has(i.sellerId) &&
        i.date.startsWith(year) &&
        i.date <= today
      ) {
        const prev = lastBuy.get(i.customerId);
        lastBuy.set(i.customerId, {
          date: i.date,
          sellerId: i.sellerId,
          total: (prev?.total ?? 0) + i.amount,
        });
      }
    const inactive = [...lastBuy.entries()]
      .filter(([, v]) => diffDays(today, v.date) > 90)
      .sort((a, b) => b[1].total - a[1].total);
    const idle = sc.full ? ds.idleProducts.filter((p) => p.companyId === q.companyId) : [];
    const mk = (
      kind: TargetList["kind"],
      title: string,
      items: TargetList["items"],
    ): TargetList => ({ kind, title, count: items.length, amount: sum(items), items });
    return [
      mk(
        "OPEN_QUOTES",
        "Orçamentos em aberto",
        quotes.map((x) => ({
          id: x.id,
          label: `${x.id} · ${x.customer}`,
          sellerId: x.sellerId,
          amount: x.amount,
          ageDays: diffDays(today, x.openedAt),
          detail: name(x.sellerId),
        })),
      ),
      mk(
        "INACTIVE_CUSTOMERS",
        "Clientes de " + year + " há mais de 90 dias sem comprar",
        inactive.map(([id, v]) => ({
          id,
          label: ds.customerNames.get(id) ?? id,
          sellerId: v.sellerId,
          amount: round2(v.total),
          ageDays: diffDays(today, v.date),
          detail: `Última compra ${v.date.split("-").reverse().join("/")} · ${name(v.sellerId)}`,
        })),
      ),
      mk(
        "LATE_ORDERS",
        "Pedidos com previsão de faturamento vencida",
        late.map((o) => ({
          id: o.id,
          label: `${o.id} · ${o.customer}`,
          sellerId: o.sellerId,
          amount: o.amount,
          ageDays: diffDays(today, o.expectedDate!),
          detail: `Previsto para ${o.expectedDate!.split("-").reverse().join("/")} · ${name(o.sellerId)}`,
        })),
      ),
      mk(
        "IDLE_STOCK",
        "Produtos parados no estoque",
        idle.map((p) => ({
          id: p.id,
          label: p.name,
          sellerId: null,
          amount: p.amount,
          ageDays: p.idleDays,
          detail: `Parado há ${p.idleDays} dias`,
        })),
      ),
    ];
  }

  return {
    api,
    setPersona(p: Persona) {
      persona = p;
    },
    getPersona: () => persona,
    failNextRead() {
      failNext = true;
    },
    setErrorRate(v: number) {
      errorRate = v;
    },
    audit: {
      list: (area?: AuditEvent["area"]) =>
        area ? audit.filter((e) => e.area === area) : [...audit],
      subscribe(l: Listener) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    weightTotal: (companyId: string, month: string) =>
      sumWeights(
        buildCalendar(month, COMPANIES.find((c) => c.id === companyId)!.saturdayWeight, HOLIDAYS),
      ),
  };
}

const LEVEL_PT: Record<TargetLevel, string> = {
  BASE: "Base",
  ACTIVE: "Ativa",
  CHALLENGE: "Desafio",
};
const STATUS_INIT_PT: Record<InitiativeStatus, string> = {
  PLANNED: "Planejada",
  IN_PROGRESS: "Em andamento",
  DONE: "Concluída",
  CANCELLED: "Cancelada",
};
const ALERT_STATE_PT: Record<AlertState, string> = {
  OPEN: "Aberto",
  ACKNOWLEDGED: "Ciente",
  ACTION_CREATED: "Ação criada",
  RESOLVED: "Resolvido",
};

export type MockFlightPlan = ReturnType<typeof createMockFlightPlan>;
