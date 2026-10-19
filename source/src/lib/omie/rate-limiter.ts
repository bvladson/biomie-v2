/**
 * OmieRateLimiter — in-process throttle for the Omie API.
 * Enforces at the same time: a global per-IP ceiling, a per App Key + method
 * ceiling, max concurrency per App Key + method, and a circuit breaker per
 * App Key + method (opened on HTTP 425). Limits are configurable and default
 * below Omie's published caps (960/min IP, 240/min key+method, 4 concurrent).
 */

export interface RateLimitConfig {
  globalPerMinute: number;
  perKeyMethodPerMinute: number;
  maxConcurrentPerKeyMethod: number;
  /** Stricter caps for specific methods (e.g. { ListarNF: 60 }). */
  methodOverrides: Record<string, number>;
  circuitOpenMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  globalPerMinute: 800,
  perKeyMethodPerMinute: 200,
  maxConcurrentPerKeyMethod: 3,
  methodOverrides: {},
  circuitOpenMs: 5 * 60_000,
};

const WINDOW = 60_000;

export class CircuitOpenError extends Error {
  constructor(
    public key: string,
    public retryAt: number,
  ) {
    super(
      `Omie bloqueou temporariamente este método (425). Nova tentativa após ${new Date(retryAt).toISOString()}.`,
    );
    this.name = "CircuitOpenError";
  }
}

export class OmieRateLimiter {
  private cfg: RateLimitConfig;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private global: number[] = [];
  private perKey = new Map<string, number[]>();
  private active = new Map<string, number>();
  private circuits = new Map<string, number>();

  constructor(
    cfg: Partial<RateLimitConfig> = {},
    deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.cfg = { ...DEFAULT_RATE_LIMIT, ...cfg };
    for (const value of [
      this.cfg.globalPerMinute,
      this.cfg.perKeyMethodPerMinute,
      this.cfg.maxConcurrentPerKeyMethod,
      this.cfg.circuitOpenMs,
      ...Object.values(this.cfg.methodOverrides),
    ]) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error("Configuração inválida dos limites Omie.");
    }
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static key(appKey: string, method: string) {
    return `${appKey}:${method}`;
  }

  limitFor(method: string) {
    return Math.min(this.cfg.perKeyMethodPerMinute, this.cfg.methodOverrides[method] ?? Infinity);
  }

  openCircuit(appKey: string, method: string) {
    this.circuits.set(OmieRateLimiter.key(appKey, method), this.now() + this.cfg.circuitOpenMs);
  }

  circuitState(appKey: string, method: string): "open" | "closed" {
    const until = this.circuits.get(OmieRateLimiter.key(appKey, method));
    return until && until > this.now() ? "open" : "closed";
  }

  private prune(arr: number[]) {
    const cutoff = this.now() - WINDOW;
    while (arr.length && arr[0]! <= cutoff) arr.shift();
  }

  /** Waits for a slot, runs fn, releases. Throws CircuitOpenError when open. */
  async run<T>(
    appKey: string,
    method: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const k = OmieRateLimiter.key(appKey, method);
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const until = this.circuits.get(k);
      if (until && until > this.now()) throw new CircuitOpenError(k, until);
      const list = this.perKey.get(k) ?? [];
      this.perKey.set(k, list);
      this.prune(list);
      this.prune(this.global);
      const conc = this.active.get(k) ?? 0;
      if (
        this.global.length < this.cfg.globalPerMinute &&
        list.length < this.limitFor(method) &&
        conc < this.cfg.maxConcurrentPerKeyMethod
      ) {
        const t = this.now();
        this.global.push(t);
        list.push(t);
        this.active.set(k, conc + 1);
        break;
      }
      const waits = [50];
      if (this.global.length >= this.cfg.globalPerMinute)
        waits.push(this.global[0]! + WINDOW - this.now());
      if (list.length >= this.limitFor(method)) waits.push(list[0]! + WINDOW - this.now());
      await abortableWait(this.sleep, Math.max(...waits, 1), signal);
    }
    try {
      return await fn();
    } finally {
      this.active.set(k, (this.active.get(k) ?? 1) - 1);
    }
  }
}

export async function abortableWait(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    sleep(ms).then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** One shared limiter per process; configure at first use, when server env is available. */
let sharedOmieLimiter: OmieRateLimiter | undefined;
export function getSharedOmieLimiter(): OmieRateLimiter {
  if (!sharedOmieLimiter) {
    const env = typeof process === "undefined" ? {} : process.env;
    sharedOmieLimiter = new OmieRateLimiter({
      globalPerMinute: Number(env["OMIE_GLOBAL_PER_MINUTE"] ?? DEFAULT_RATE_LIMIT.globalPerMinute),
      perKeyMethodPerMinute: Number(
        env["OMIE_KEY_METHOD_PER_MINUTE"] ?? DEFAULT_RATE_LIMIT.perKeyMethodPerMinute,
      ),
      maxConcurrentPerKeyMethod: Number(
        env["OMIE_MAX_CONCURRENT"] ?? DEFAULT_RATE_LIMIT.maxConcurrentPerKeyMethod,
      ),
    });
  }
  return sharedOmieLimiter;
}
