import { afterEach, describe, expect, it, vi } from "vitest";
import { callScheduledJob, schedulerConfig, schedulerTick, snapshotDueDay } from "./scheduler";

const config = schedulerConfig({
  APP_BASE_URL: "http://web:3000/",
  BIOMIE_JOB_TOKEN: "test-token",
});
afterEach(() => vi.restoreAllMocks());

describe("VPS scheduler", () => {
  it("validates config without accepting URL credentials or invalid delays", () => {
    expect(config.baseUrl).toBe("http://web:3000");
    expect(() =>
      schedulerConfig({
        APP_BASE_URL: "https://user:secret@example.com",
        BIOMIE_JOB_TOKEN: "token",
      }),
    ).toThrow();
    expect(() =>
      schedulerConfig({
        APP_BASE_URL: "http://web",
        BIOMIE_JOB_TOKEN: "token",
        BIOMIE_JOB_TIMEOUT_MS: "0",
      }),
    ).toThrow();
  });

  it("does not overlap ticks while the previous request is pending", async () => {
    let finish!: (ok: boolean) => void;
    const call = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const tick = schedulerTick(config, call);
    const first = tick(new Date("2026-10-19T07:00:00Z"));
    await tick(new Date("2026-10-19T07:01:00Z"));
    expect(call).toHaveBeenCalledTimes(1);
    finish(true);
    await first;
  });

  it("retries a failed snapshot, catches up after its hour, then skips a completed day", async () => {
    let snapshots = 0;
    const call = vi.fn(async (path: string) =>
      path.endsWith("snapshots") ? ++snapshots > 1 : true,
    );
    const tick = schedulerTick(config, call);
    await tick(new Date("2026-10-19T12:00:00Z"));
    await tick(new Date("2026-10-19T12:01:00Z"));
    await tick(new Date("2026-10-19T12:02:00Z"));
    expect(snapshots).toBe(2);
    await tick(new Date("2026-10-20T08:00:00Z"));
    expect(snapshots).toBe(3);
  });

  it("uses the configured timezone instead of the host timezone", () => {
    const local = { snapshotTimeZone: "America/Sao_Paulo", snapshotHour: 5 };
    expect(snapshotDueDay(new Date("2026-10-19T07:59:00Z"), local)).toBeNull();
    expect(snapshotDueDay(new Date("2026-10-19T08:00:00Z"), local)).toBe("2026-10-19");
  });

  it("treats HTTP 200 with a FAILED job as failure and never logs the body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "FAILED", secret: "sensitive-response" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    expect(
      await callScheduledJob(config, "/jobs/test", new AbortController().signal, fetchImpl),
    ).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-response");
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-token");
  });
});
