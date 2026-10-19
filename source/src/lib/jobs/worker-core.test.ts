import { describe, expect, it } from "vitest";
import {
  initialWorkerState,
  parseBlackouts,
  workerConfig,
  workerTick,
  type WorkerDeps,
} from "./worker-core";

function harness(options: {
  paused?: boolean;
  recurring?: boolean;
  load?: number;
  jobs?: number;
  at?: string;
  blackouts?: string;
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

  it("runs the Flight Plan snapshot once per local day after the configured hour", async () => {
    const { deps, calls, config, advance } = harness({ at: "2026-10-21T13:00:00Z" });
    const state = initialWorkerState();
    await workerTick(config, deps, state);
    advance(60 * 60_000);
    await workerTick(config, deps, state);
    expect(calls.snapshots).toBe(1);
  });
});

describe("worker configuration", () => {
  it("requires explicit time zones in blackout windows", () => {
    expect(() => parseBlackouts("2026-10-20T19:30/2026-10-20T21:00")).toThrow();
    expect(parseBlackouts("2026-10-20T19:30-03:00/2026-10-20T21:00-03:00")).toHaveLength(1);
    expect(parseBlackouts(undefined)).toEqual([]);
  });
  it("rejects invalid numeric settings", () => {
    expect(() => workerConfig({ BIOMIE_WORKER_MAX_LOAD_PER_CPU: "-1" })).toThrow();
    expect(workerConfig({}).maxLoadPerCpu).toBe(0.75);
  });
});
