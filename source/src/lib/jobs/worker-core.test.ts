import { describe, expect, it } from "vitest";
import {
  initialWorkerState,
  parseBlackouts,
  parseSlotMinutes,
  stockSlot,
  workerConfig,
  workerTick,
  type StockSchedule,
  type WorkerDeps,
} from "./worker-core";

function harness(options: {
  paused?: boolean;
  recurring?: boolean;
  load?: number;
  jobs?: number;
  at?: string;
  blackouts?: string;
  txMinutes?: string;
}) {
  let clock = Date.parse(options.at ?? "2026-10-21T13:00:00Z");
  let pending = options.jobs ?? 0;
  const calls = {
    steps: 0,
    enqueue: [] as string[],
    snapshots: 0,
    status: [] as Record<string, unknown>[],
  };
  const deps: WorkerDeps = {
    now: () => new Date(clock),
    readControl: async () => ({
      paused: options.paused ?? false,
      recurring: options.recurring ?? false,
    }),
    reportStatus: async (status) => void calls.status.push(status),
    loadAverage: () => ({ load1: options.load ?? 0.1, cpus: 4 }),
    heartbeat: () => {},
    runDimensionJob: async () => ({ jobId: null }),
    runBackfillStep: async () => {
      clock += 5_000;
      if (pending <= 0) return { jobId: null };
      pending--;
      calls.steps++;
      return { jobId: "job", status: "RUNNING", done: false };
    },
    enqueueRecurring: async (kind) => {
      calls.enqueue.push(kind);
      return 1;
    },
    runSnapshot: async () => {
      calls.snapshots++;
      return true;
    },
    log: () => {},
  };
  const config = workerConfig({
    BIOMIE_WORKER_TICK_BUDGET_MS: "20000",
    BIOMIE_WORKER_BLACKOUTS: options.blackouts,
    BIOMIE_RECURRING_TX_MINUTES: options.txMinutes,
  });
  return { deps, calls, config, advance: (ms: number) => (clock += ms) };
}

describe("worker tick", () => {
  it("does nothing while paused and reports the pause", async () => {
    const { deps, calls, config } = harness({ paused: true, jobs: 3 });
    const result = await workerTick(config, deps, initialWorkerState());
    expect(result.state).toBe("PAUSED");
    expect(calls.steps).toBe(0);
    expect(calls.status.at(-1)?.["state"]).toBe("PAUSED");
  });

  it("never runs inside a blackout window (VSB maintenance)", async () => {
    const { deps, calls, config } = harness({
      jobs: 3,
      at: "2026-10-20T22:45:00Z",
      blackouts: "2026-10-20T19:30-03:00/2026-10-20T21:00-03:00",
    });
    expect((await workerTick(config, deps, initialWorkerState())).state).toBe("BLACKOUT");
    expect(calls.steps).toBe(0);
  });

  it("yields when the host is busy", async () => {
    const { deps, calls, config } = harness({ jobs: 3, load: 3.6 });
    expect((await workerTick(config, deps, initialWorkerState())).state).toBe("THROTTLED");
    expect(calls.steps).toBe(0);
  });

  it("advances queued steps only inside the tick budget", async () => {
    const { deps, calls, config } = harness({ jobs: 50 });
    const result = await workerTick(config, deps, initialWorkerState());
    expect(result.state).toBe("RUNNING");
    expect(calls.steps).toBeGreaterThan(0);
    expect(calls.steps).toBeLessThan(50);
  });

  it("enqueues recurring work only when enabled, at its cadence", async () => {
    const off = harness({ recurring: false });
    await workerTick(off.config, off.deps, initialWorkerState());
    expect(off.calls.enqueue).toEqual([]);

    const on = harness({ recurring: true, at: "2026-10-21T13:00:00Z" });
    const state = initialWorkerState();
    await workerTick(on.config, on.deps, state);
    expect(on.calls.enqueue).toEqual(["transactions", "dimensions"]);
    on.advance(5 * 60_000);
    await workerTick(on.config, on.deps, state);
    expect(on.calls.enqueue).toEqual(["transactions", "dimensions"]);
    on.advance(31 * 60_000);
    await workerTick(on.config, on.deps, state);
    expect(on.calls.enqueue).toEqual(["transactions", "dimensions", "transactions"]);
  });

  it("starts recurring transactions only inside fixed local slots (legacy quiet minutes)", async () => {
    // 20:20Z = 17:20 in America/Fortaleza.
    const on = harness({ recurring: true, txMinutes: "21,51", at: "2026-10-21T20:20:00Z" });
    const state = initialWorkerState();
    const tx = () => on.calls.enqueue.filter((kind) => kind === "transactions").length;
    await workerTick(on.config, on.deps, state);
    expect(tx()).toBe(0);
    on.advance(60_000); // 17:21
    await workerTick(on.config, on.deps, state);
    expect(tx()).toBe(1);
    on.advance(2 * 60_000); // 17:23, same slot
    await workerTick(on.config, on.deps, state);
    expect(tx()).toBe(1);
    on.advance(10 * 60_000); // 17:33
    await workerTick(on.config, on.deps, state);
    expect(tx()).toBe(1);
    on.advance(18 * 60_000); // 17:51
    await workerTick(on.config, on.deps, state);
    expect(tx()).toBe(2);

    // A restart outside a slot window waits for the next slot.
    const restarted = harness({ recurring: true, txMinutes: "21,51", at: "2026-10-21T21:05:00Z" });
    await workerTick(restarted.config, restarted.deps, initialWorkerState());
    expect(restarted.calls.enqueue.filter((kind) => kind === "transactions")).toEqual([]);
  });

  it("runs the Flight Plan snapshot once per local day after the configured hour", async () => {
    const { deps, calls, config, advance } = harness({ at: "2026-10-21T13:00:00Z" });
    const state = initialWorkerState();
    await workerTick(config, deps, state);
    advance(60 * 60_000);
    await workerTick(config, deps, state);
    expect(calls.snapshots).toBe(1);
  });
});

const SCHEDULE: StockSchedule = {
  readingEnabled: true,
  slots: ["07:40", "12:40", "17:40"],
  closeSlot: "23:50",
};

describe("stock reading in the worker tick", () => {
  function stockHarness(options: {
    enabled?: boolean;
    recurring?: boolean;
    at: string;
    failStep?: boolean;
    failSchedule?: boolean;
    failEnqueue?: boolean;
    jobs?: number;
  }) {
    const base = harness({
      recurring: options.recurring ?? true,
      at: options.at,
      jobs: options.jobs ?? 0,
    });
    const stock = { enqueued: [] as string[], steps: 0 };
    base.deps.stockSchedule = async () => {
      if (options.failSchedule) throw new Error("rpc ausente");
      return { ...SCHEDULE, readingEnabled: options.enabled ?? true };
    };
    base.deps.enqueueStock = async (slot, kind, day) => {
      if (options.failEnqueue) throw new Error("falhou");
      stock.enqueued.push(`${slot}|${kind}|${day}`);
      return 2;
    };
    base.deps.runStockStep = async () => {
      if (options.failStep) throw new Error("falhou");
      stock.steps++;
      return { jobId: "stock-1", status: "RUNNING", done: false };
    };
    return { ...base, stock };
  }

  it("stays idle while the reading is off (default after the migration)", async () => {
    // 10:41Z = 07:41 em America/Fortaleza, dentro do horário 07:40.
    const h = stockHarness({ enabled: false, at: "2026-10-21T10:41:00Z" });
    await workerTick(h.config, h.deps, initialWorkerState());
    expect(h.stock.enqueued).toEqual([]);
    expect(h.stock.steps).toBe(0);
  });

  it("enqueues once per slot and runs one stock step per tick", async () => {
    const h = stockHarness({ at: "2026-10-21T10:41:00Z" });
    const state = initialWorkerState();
    await workerTick(h.config, h.deps, state);
    h.advance(60_000);
    await workerTick(h.config, h.deps, state);
    expect(h.stock.enqueued).toEqual(["2026-10-21 07:40|intraday|2026-10-21"]);
    expect(h.stock.steps).toBe(2);
    expect(h.calls.status.at(-1)?.["stock"]).toEqual({ readingEnabled: true, lastStep: "RUNNING" });
  });

  it("does not schedule when recurring loads are off, but still finishes queued readings", async () => {
    const h = stockHarness({ recurring: false, at: "2026-10-21T10:41:00Z" });
    await workerTick(h.config, h.deps, initialWorkerState());
    expect(h.stock.enqueued).toEqual([]);
    expect(h.stock.steps).toBe(1);
  });

  it("marks the 23:50 reading as the daily close", async () => {
    // 02:51Z de 22/10 = 23:51 de 21/10 em Fortaleza.
    const h = stockHarness({ at: "2026-10-22T02:51:00Z" });
    await workerTick(h.config, h.deps, initialWorkerState());
    expect(h.stock.enqueued).toEqual(["2026-10-21 23:50|close|2026-10-21"]);
  });

  it("never lets a stock failure stop the existing loads", async () => {
    for (const failure of [{ failSchedule: true }, { failStep: true }, { failEnqueue: true }]) {
      const h = stockHarness({ ...failure, at: "2026-10-21T10:41:00Z", jobs: 2 });
      const result = await workerTick(h.config, h.deps, initialWorkerState());
      expect(h.calls.steps).toBe(2);
      expect(result.state).toBe("RUNNING");
    }
  });
});

describe("stock slots", () => {
  it("opens each slot for five minutes and prefers the daily close", () => {
    const at = (hour: number, minute: number) => ({ day: "2026-10-21", hour, minute });
    expect(stockSlot(at(7, 39), SCHEDULE)).toBeNull();
    expect(stockSlot(at(7, 40), SCHEDULE)).toEqual({ key: "2026-10-21 07:40", kind: "intraday" });
    expect(stockSlot(at(7, 44), SCHEDULE)).toEqual({ key: "2026-10-21 07:40", kind: "intraday" });
    expect(stockSlot(at(7, 45), SCHEDULE)).toBeNull();
    expect(stockSlot(at(23, 52), SCHEDULE)).toEqual({ key: "2026-10-21 23:50", kind: "close" });
    expect(stockSlot(at(12, 40), { ...SCHEDULE, closeSlot: "12:40" })?.kind).toBe("close");
    expect(stockSlot(at(7, 40), { ...SCHEDULE, slots: ["7:40"] })).toBeNull();
  });
});

describe("worker configuration", () => {
  it("requires explicit time zones in blackout windows", () => {
    expect(() => parseBlackouts("2026-10-20T19:30/2026-10-20T21:00")).toThrow();
    expect(parseBlackouts("2026-10-20T19:30-03:00/2026-10-20T21:00-03:00")).toHaveLength(1);
    expect(parseBlackouts(undefined)).toEqual([]);
  });
  it("parses recurring slot minutes", () => {
    expect(parseSlotMinutes("51, 21,21")).toEqual([21, 51]);
    expect(parseSlotMinutes(undefined)).toEqual([]);
    expect(() => parseSlotMinutes("60")).toThrow();
    expect(() => parseSlotMinutes("a")).toThrow();
  });
  it("rejects invalid numeric settings", () => {
    expect(() => workerConfig({ BIOMIE_WORKER_MAX_LOAD_PER_CPU: "-1" })).toThrow();
    expect(workerConfig({}).maxLoadPerCpu).toBe(0.75);
  });
});
