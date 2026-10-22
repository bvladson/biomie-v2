/**
 * Worker core (pure, testable). The worker is the only production process that
 * loads Omie data: queued backfills, dimension requests, recurring refresh and
 * the daily Flight Plan snapshot. The web process never runs heavy loads.
 *
 * Control: pause/resume and recurring on/off are read from the database every
 * tick (set through worker-ctl or by a SUPER_ADMIN). Status and a heartbeat are
 * written back. The tick yields when the host is busy (load average per CPU)
 * and never runs inside configured blackout windows (e.g. VSB maintenance).
 */

export interface BlackoutWindow {
  from: number;
  to: number;
  label: string;
}

export interface WorkerConfig {
  intervalMs: number;
  tickBudgetMs: number;
  maxLoadPerCpu: number;
  blackouts: BlackoutWindow[];
  snapshotHour: number;
  snapshotTimeZone: string;
  recurringTransactionsEveryMs: number;
  recurringTransactionsDays: number;
  /**
   * Fixed local minutes (e.g. [21, 51]) at which recurring transactions start.
   * Empty = every recurringTransactionsEveryMs since the last enqueue.
   */
  recurringTransactionsMinutes: number[];
  recurringDimensionsHour: number;
  weeklyReplayWeekday: number;
  weeklyReplayHour: number;
}

export interface WorkerControl {
  paused: boolean;
  recurring: boolean;
  reason?: string;
}

export interface StepOutcome {
  jobId: string | null;
  status?: string | null;
  done?: boolean;
}

/** Leitura do estoque (migração 0041): desligada até a validação com o Omie. */
export interface StockSchedule {
  readingEnabled: boolean;
  /** "HH:MM" locais das leituras do dia. */
  slots: string[];
  /** "HH:MM" local do fechamento diário (fica no histórico). */
  closeSlot: string;
}

export interface WorkerDeps {
  now(): Date;
  readControl(): Promise<WorkerControl>;
  reportStatus(status: Record<string, unknown>): Promise<void>;
  loadAverage(): { load1: number; cpus: number };
  heartbeat(): void;
  runDimensionJob(): Promise<StepOutcome>;
  runBackfillStep(): Promise<StepOutcome>;
  enqueueRecurring(kind: "transactions" | "dimensions" | "replay", today: string): Promise<number>;
  runSnapshot(): Promise<boolean>;
  log(event: Record<string, unknown>): void;
  /** Estoque: opcional e isolado — uma falha aqui nunca interrompe as cargas existentes. */
  stockSchedule?(): Promise<StockSchedule | null>;
  enqueueStock?(slot: string, kind: "intraday" | "close", day: string): Promise<number>;
  runStockStep?(): Promise<StepOutcome>;
}

export interface WorkerState {
  lastTransactionsEnqueue: number;
  lastTransactionsSlot: string | null;
  lastDimensionsDay: string | null;
  lastReplayDay: string | null;
  lastSnapshotDay: string | null;
  lastStockSlot: string | null;
}

export const initialWorkerState = (): WorkerState => ({
  lastTransactionsEnqueue: 0,
  lastTransactionsSlot: null,
  lastDimensionsDay: null,
  lastReplayDay: null,
  lastSnapshotDay: null,
  lastStockSlot: null,
});

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} inválido.`);
  return parsed;
}

/** "2026-10-20T19:30-03:00/2026-10-20T21:00-03:00;..." — explicit offsets required. */
export function parseBlackouts(value: string | undefined): BlackoutWindow[] {
  if (!value?.trim()) return [];
  return value.split(";").map((part) => {
    const [from, to] = part.trim().split("/");
    const offset = /(Z|[+-]\d{2}:\d{2})$/;
    if (!from || !to || !offset.test(from) || !offset.test(to))
      throw new Error("BIOMIE_WORKER_BLACKOUTS precisa de início/fim com fuso explícito.");
    const window = { from: Date.parse(from), to: Date.parse(to), label: part.trim() };
    if (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.to <= window.from)
      throw new Error("Janela de bloqueio inválida em BIOMIE_WORKER_BLACKOUTS.");
    return window;
  });
}

/** "21,51" -> [21, 51]: local minutes at which recurring transactions start. */
export function parseSlotMinutes(value: string | undefined): number[] {
  if (!value?.trim()) return [];
  const minutes = value.split(",").map((part) => Number(part.trim()));
  if (minutes.some((m) => !Number.isInteger(m) || m < 0 || m > 59))
    throw new Error("BIOMIE_RECURRING_TX_MINUTES inválido.");
  return [...new Set(minutes)].sort((a, b) => a - b);
}

/** Slots open for this many minutes; a worker that missed the window waits for the next slot. */
export const SLOT_WINDOW_MINUTES = 5;

/** The slot active now ("YYYY-MM-DD HH:mm", local), or null outside every slot window. */
export function transactionSlot(
  local: { day: string; hour: number; minute: number },
  minutes: number[],
): string | null {
  const start = minutes.find((m) => local.minute >= m && local.minute < m + SLOT_WINDOW_MINUTES);
  if (start === undefined) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.day} ${pad(local.hour)}:${pad(start)}`;
}

/**
 * Horário de leitura do estoque aberto agora ("YYYY-MM-DD HH:MM" local + tipo), ou null.
 * O fechamento diário vence uma leitura do dia marcada no mesmo minuto.
 */
export function stockSlot(
  local: { day: string; hour: number; minute: number },
  schedule: StockSchedule,
): { key: string; kind: "intraday" | "close" } | null {
  const minuteOfDay = local.hour * 60 + local.minute;
  const open = (slot: string) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(slot);
    if (!match) return false;
    const start = Number(match[1]) * 60 + Number(match[2]);
    return minuteOfDay >= start && minuteOfDay < start + SLOT_WINDOW_MINUTES;
  };
  if (open(schedule.closeSlot)) return { key: `${local.day} ${schedule.closeSlot}`, kind: "close" };
  const slot = schedule.slots.find(open);
  return slot ? { key: `${local.day} ${slot}`, kind: "intraday" } : null;
}

export function workerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const snapshotTimeZone = env["BIOMIE_SNAPSHOT_TIME_ZONE"] ?? "America/Fortaleza";
  new Intl.DateTimeFormat("en", { timeZone: snapshotTimeZone }).format(new Date());
  return {
    intervalMs: integer(
      env["BIOMIE_WORKER_INTERVAL_MS"],
      30_000,
      1_000,
      3_600_000,
      "BIOMIE_WORKER_INTERVAL_MS",
    ),
    tickBudgetMs: integer(
      env["BIOMIE_WORKER_TICK_BUDGET_MS"],
      25_000,
      1_000,
      3_600_000,
      "BIOMIE_WORKER_TICK_BUDGET_MS",
    ),
    maxLoadPerCpu: integer(
      env["BIOMIE_WORKER_MAX_LOAD_PER_CPU"],
      0.75,
      0.05,
      8,
      "BIOMIE_WORKER_MAX_LOAD_PER_CPU",
    ),
    blackouts: parseBlackouts(env["BIOMIE_WORKER_BLACKOUTS"]),
    snapshotHour: integer(env["BIOMIE_SNAPSHOT_HOUR"], 8, 0, 23, "BIOMIE_SNAPSHOT_HOUR"),
    snapshotTimeZone,
    recurringTransactionsEveryMs: integer(
      env["BIOMIE_RECURRING_TX_EVERY_MS"],
      30 * 60_000,
      60_000,
      24 * 3_600_000,
      "BIOMIE_RECURRING_TX_EVERY_MS",
    ),
    recurringTransactionsDays: integer(
      env["BIOMIE_RECURRING_TX_DAYS"],
      62,
      1,
      400,
      "BIOMIE_RECURRING_TX_DAYS",
    ),
    recurringTransactionsMinutes: parseSlotMinutes(env["BIOMIE_RECURRING_TX_MINUTES"]),
    recurringDimensionsHour: integer(
      env["BIOMIE_RECURRING_DIMENSIONS_HOUR"],
      6,
      0,
      23,
      "BIOMIE_RECURRING_DIMENSIONS_HOUR",
    ),
    weeklyReplayWeekday: integer(
      env["BIOMIE_WEEKLY_REPLAY_WEEKDAY"],
      0,
      0,
      6,
      "BIOMIE_WEEKLY_REPLAY_WEEKDAY",
    ),
    weeklyReplayHour: integer(
      env["BIOMIE_WEEKLY_REPLAY_HOUR"],
      5,
      0,
      23,
      "BIOMIE_WEEKLY_REPLAY_HOUR",
    ),
  };
}

/** Local calendar parts in the business time zone. */
export function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday,
  };
}

export function activeBlackout(now: Date, windows: BlackoutWindow[]): BlackoutWindow | null {
  const t = now.getTime();
  return windows.find((w) => t >= w.from && t < w.to) ?? null;
}

export function hostTooBusy(load: { load1: number; cpus: number }, maxLoadPerCpu: number): boolean {
  return load.cpus > 0 && load.load1 / load.cpus > maxLoadPerCpu;
}

export interface TickResult {
  state: "PAUSED" | "BLACKOUT" | "THROTTLED" | "RUNNING" | "IDLE";
  steps: number;
  enqueued: number;
  snapshot: boolean;
}

/** One bounded worker tick. Never throws for job failures; they are recorded per job. */
export async function workerTick(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  state: WorkerState,
): Promise<TickResult> {
  const started = deps.now().getTime();
  deps.heartbeat();
  const control = await deps.readControl();
  const base = { at: deps.now().toISOString(), recurring: control.recurring };
  if (control.paused) {
    await deps.reportStatus({ ...base, state: "PAUSED", reason: control.reason ?? null });
    return { state: "PAUSED", steps: 0, enqueued: 0, snapshot: false };
  }
  const blackout = activeBlackout(deps.now(), cfg.blackouts);
  if (blackout) {
    await deps.reportStatus({ ...base, state: "BLACKOUT", window: blackout.label });
    return { state: "BLACKOUT", steps: 0, enqueued: 0, snapshot: false };
  }
  const load = deps.loadAverage();
  if (hostTooBusy(load, cfg.maxLoadPerCpu)) {
    await deps.reportStatus({ ...base, state: "THROTTLED", load1: load.load1, cpus: load.cpus });
    return { state: "THROTTLED", steps: 0, enqueued: 0, snapshot: false };
  }

  const local = localParts(deps.now(), cfg.snapshotTimeZone);
  let enqueued = 0;
  let stock: StockSchedule | null = null;
  if (deps.stockSchedule) {
    try {
      stock = await deps.stockSchedule();
    } catch {
      stock = null;
      deps.log({ event: "stock_schedule_unavailable" });
    }
  }
  if (control.recurring && stock?.readingEnabled && deps.enqueueStock) {
    const slot = stockSlot(local, stock);
    if (slot && slot.key !== state.lastStockSlot) {
      try {
        enqueued += await deps.enqueueStock(slot.key, slot.kind, local.day);
      } catch {
        deps.log({ event: "stock_enqueue_failed", slot: slot.key });
      }
      state.lastStockSlot = slot.key;
    }
  }
  if (control.recurring) {
    // Fixed local slots keep Omie calls in the quiet minutes of the legacy
    // BIomie, which shares the same Omie applications (sync every 15 min).
    const slot = transactionSlot(local, cfg.recurringTransactionsMinutes);
    const due = cfg.recurringTransactionsMinutes.length
      ? slot !== null && slot !== state.lastTransactionsSlot
      : started - state.lastTransactionsEnqueue >= cfg.recurringTransactionsEveryMs;
    if (due) {
      enqueued += await deps.enqueueRecurring("transactions", local.day);
      state.lastTransactionsEnqueue = started;
      state.lastTransactionsSlot = slot;
    }
    if (local.hour >= cfg.recurringDimensionsHour && state.lastDimensionsDay !== local.day) {
      enqueued += await deps.enqueueRecurring("dimensions", local.day);
      state.lastDimensionsDay = local.day;
    }
    if (
      local.weekday === cfg.weeklyReplayWeekday &&
      local.hour >= cfg.weeklyReplayHour &&
      state.lastReplayDay !== local.day
    ) {
      enqueued += await deps.enqueueRecurring("replay", local.day);
      state.lastReplayDay = local.day;
    }
  }

  let snapshot = false;
  if (local.hour >= cfg.snapshotHour && state.lastSnapshotDay !== local.day) {
    snapshot = await deps.runSnapshot();
    if (snapshot) state.lastSnapshotDay = local.day;
  }

  let steps = 0;
  let lastJob: string | null = null;
  const dimension = await deps.runDimensionJob();
  if (dimension.jobId) {
    steps++;
    lastJob = dimension.jobId;
  }
  let stockStatus: string | null = null;
  if (stock?.readingEnabled && deps.runStockStep) {
    try {
      const step = await deps.runStockStep();
      if (step.jobId) {
        steps++;
        lastJob = step.jobId;
        stockStatus = step.status ?? null;
      }
    } catch {
      deps.log({ event: "stock_step_failed" });
      stockStatus = "ERROR";
    }
  }
  while (deps.now().getTime() - started < cfg.tickBudgetMs) {
    if (hostTooBusy(deps.loadAverage(), cfg.maxLoadPerCpu)) break;
    deps.heartbeat();
    const step = await deps.runBackfillStep();
    if (!step.jobId) break;
    steps++;
    lastJob = step.jobId;
  }
  const resultState = steps ? "RUNNING" : "IDLE";
  await deps.reportStatus({
    ...base,
    state: resultState,
    steps,
    enqueued,
    snapshot,
    lastJob,
    ...(stock ? { stock: { readingEnabled: stock.readingEnabled, lastStep: stockStatus } } : {}),
  });
  return { state: resultState, steps, enqueued, snapshot };
}
