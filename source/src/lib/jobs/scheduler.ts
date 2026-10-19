export interface SchedulerConfig {
  baseUrl: string;
  token: string;
  intervalMs: number;
  timeoutMs: number;
  snapshotHour: number;
  snapshotTimeZone: string;
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} inválido.`);
  return parsed;
}

export function schedulerConfig(env: Record<string, string | undefined>): SchedulerConfig {
  const url = new URL(env["APP_BASE_URL"] ?? "");
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("APP_BASE_URL deve ser uma URL HTTP(S) sem credenciais, query ou fragmento.");
  const token = env["BIOMIE_JOB_TOKEN"]?.trim();
  if (!token || /\s/.test(token))
    throw new Error("BIOMIE_JOB_TOKEN é obrigatório e não pode conter espaços.");
  const snapshotTimeZone = env["BIOMIE_SNAPSHOT_TIME_ZONE"] ?? "UTC";
  new Intl.DateTimeFormat("en", { timeZone: snapshotTimeZone }).format(new Date());
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    token,
    intervalMs: integer(
      env["BIOMIE_WORKER_INTERVAL_MS"],
      60_000,
      1_000,
      3_600_000,
      "BIOMIE_WORKER_INTERVAL_MS",
    ),
    timeoutMs: integer(
      env["BIOMIE_JOB_TIMEOUT_MS"],
      240_000,
      1_000,
      600_000,
      "BIOMIE_JOB_TIMEOUT_MS",
    ),
    snapshotHour: integer(env["BIOMIE_SNAPSHOT_HOUR"], 8, 0, 23, "BIOMIE_SNAPSHOT_HOUR"),
    snapshotTimeZone,
  };
}

/** Explicit timezone; catches up when the process restarts later that day. */
export function snapshotDueDay(
  now: Date,
  config: Pick<SchedulerConfig, "snapshotTimeZone" | "snapshotHour">,
): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.snapshotTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return Number(part("hour")) >= config.snapshotHour
    ? `${part("year")}-${part("month")}-${part("day")}`
    : null;
}

export async function callScheduledJob(
  config: SchedulerConfig,
  path: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, config.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(config.baseUrl + path, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    const status = String(body?.status ?? "INVALID_RESPONSE");
    const ok =
      response.ok && ["IDLE", "RUNNING", "SUCCESS", "WARNING", "success", "BUSY"].includes(status);
    // Never print response bodies, bearer tokens or arbitrary upstream errors.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        job: path,
        http: response.status,
        status: ok ? status : "FAILED",
        durationMs: Date.now() - started,
      }),
    );
    return ok;
  } catch {
    if (!signal.aborted)
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          job: path,
          status: "REQUEST_FAILED",
          durationMs: Date.now() - started,
        }),
      );
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function schedulerTick(config: SchedulerConfig, call: (path: string) => Promise<boolean>) {
  let lastSnapshotDay: string | null = null;
  let running = false;
  return async (now = new Date()) => {
    if (running) return;
    running = true;
    try {
      await call("/api/public/jobs/omie-backfill");
      const day = snapshotDueDay(now, config);
      if (day && day !== lastSnapshotDay && (await call("/api/public/jobs/flight-plan-snapshots")))
        lastSnapshotDay = day;
    } finally {
      running = false;
    }
  };
}

export async function runScheduler(config: SchedulerConfig, signal: AbortSignal) {
  const tick = schedulerTick(config, (path) => callScheduledJob(config, path, signal));
  while (!signal.aborted) {
    await tick();
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, config.intervalMs);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
