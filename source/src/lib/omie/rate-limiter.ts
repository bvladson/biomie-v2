/**
 * OmieRateLimiter — in-process throttle for the Omie API (the worker is the
 * only production process that loads data, so this is the effective v2 limit).
 *
 * Enforces at the same time:
 * - a global per-IP ceiling and a per App Key + method ceiling;
 * - max concurrency per App Key + method;
 * - a minimum spacing between IDENTICAL requests (Omie rejects the same query
 *   repeated within 60 s as "consumo redundante" and every repetition extends
 *   the block);
 * - a circuit breaker per App Key + method (HTTP 425 / blocked);
 * - an error budget per App Key: Omie blocks an application for 30 minutes
 *   after ~10 errors, so the key is paused well before that, and an invalid
 *   key (auth error) is paused immediately.
 * Defaults stay below Omie's published caps (960/min IP, 240/min key+method,
 * 4 concurrent); production values come from the environment.
 */

export interface RateLimitConfig {
  globalPerMinute: number;
  perKeyMethodPerMinute: number;
  maxConcurrentPerKeyMethod: number;
  /** Stricter caps for specific methods (e.g. { ListarNF: 60 }). */
  methodOverrides: Record<string, number>;
  /** How long a blocked method/key stays closed (Omie blocks for 30 minutes). */
  circuitOpenMs: number;
  /** Minimum interval between two identical requests. */
  redundantSpacingMs: number;
  /**
   * Minimum pause between the end of one call and the start of the next call of
   * the same method with the same App Key (Omie answers "já existe uma requisição
   * desse método sendo executada" to back-to-back calls).
   */
  minMethodGapMs: number;
  /**
   * Extra pause after an EMPTY page ("não existem registros") before the next call of the same
   * method and key: Omie answers fast but still holds the call for some seconds, and the next one
   * comes back "já existe uma requisição desse método" (MAG Matriz, 23/10/2026: 3 per cycle). 0 = off.
   */
  emptyPageGapMs: number;
  /** After a "já existe uma requisição" answer, calls of that method and key are spaced by this. 0 = off. */
  busyGapMs: number;
  /** How long the wider spacing lasts after the last "já existe uma requisição" answer. */
  busyGapWindowMs: number;
  /** Errors per App Key inside the window that pause the whole key. */
  keyErrorBudget: number;
  keyErrorWindowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  globalPerMinute: 800,
  perKeyMethodPerMinute: 200,
  maxConcurrentPerKeyMethod: 3,
  methodOverrides: {},
  circuitOpenMs: 30 * 60_000,
  redundantSpacingMs: 61_000,
  minMethodGapMs: 2_000,
  emptyPageGapMs: 12_000,
  busyGapMs: 20_000,
  busyGapWindowMs: 10 * 60_000,
  keyErrorBudget: 5,
  keyErrorWindowMs: 30 * 60_000,
};

const WINDOW = 60_000;
const KEY_SCOPE = "*";

export class CircuitOpenError extends Error {
  constructor(
    public key: string,
    public retryAt: number,
  ) {
    super(
      `Omie bloqueado temporariamente para esta chave/método. Nova tentativa após ${new Date(retryAt).toISOString()}.`,
    );
    this.name = "CircuitOpenError";
  }
}

export type FailureKind = "auth" | "blocked" | "rate_limit" | "client" | "server";

export class OmieRateLimiter {
  private cfg: RateLimitConfig;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private global: number[] = [];
  private perKey = new Map<string, number[]>();
  private active = new Map<string, number>();
  private circuits = new Map<string, number>();
  private lastRequest = new Map<string, number>();
  private lastMethodCall = new Map<string, number>();
  private keyErrors = new Map<string, number[]>();
  /** Earliest start of the next call of a key+method (after an empty page). */
  private notBefore = new Map<string, number>();
  /** Until when a key+method keeps the wider spacing (after a busy answer). */
  private busyUntil = new Map<string, number>();

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
      this.cfg.keyErrorBudget,
      this.cfg.keyErrorWindowMs,
      ...Object.values(this.cfg.methodOverrides),
    ]) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error("Configuração inválida dos limites Omie.");
    }
    for (const value of [
      this.cfg.redundantSpacingMs,
      this.cfg.minMethodGapMs,
      this.cfg.emptyPageGapMs,
      this.cfg.busyGapMs,
      this.cfg.busyGapWindowMs,
    ])
      if (!Number.isFinite(value) || value < 0)
        throw new Error("Configuração inválida dos limites Omie.");
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static key(appKey: string, method: string) {
    return `${appKey}:${method}`;
  }

  limitFor(method: string) {
    return Math.min(this.cfg.perKeyMethodPerMinute, this.cfg.methodOverrides[method] ?? Infinity);
  }

  get circuitOpenMs() {
    return this.cfg.circuitOpenMs;
  }

  openCircuit(appKey: string, method: string, ms = this.cfg.circuitOpenMs) {
    const key = OmieRateLimiter.key(appKey, method);
    this.circuits.set(key, Math.max(this.circuits.get(key) ?? 0, this.now() + ms));
  }

  /** Pauses every method of an App Key (invalid credentials, error budget exhausted). */
  openKeyCircuit(appKey: string, ms = this.cfg.circuitOpenMs) {
    this.openCircuit(appKey, KEY_SCOPE, ms);
  }

  circuitState(appKey: string, method: string): "open" | "closed" {
    const now = this.now();
    const until = Math.max(
      this.circuits.get(OmieRateLimiter.key(appKey, method)) ?? 0,
      this.circuits.get(OmieRateLimiter.key(appKey, KEY_SCOPE)) ?? 0,
    );
    return until > now ? "open" : "closed";
  }

  /** Omie answered an empty page: the next call of this method waits emptyPageGapMs. */
  noteEmptyPage(appKey: string, method: string) {
    if (this.cfg.emptyPageGapMs <= 0) return;
    const k = OmieRateLimiter.key(appKey, method);
    this.notBefore.set(
      k,
      Math.max(this.notBefore.get(k) ?? 0, this.now() + this.cfg.emptyPageGapMs),
    );
  }

  /** Omie answered "já existe uma requisição desse método": space this method for a while. */
  noteBusy(appKey: string, method: string) {
    if (this.cfg.busyGapMs <= 0) return;
    this.busyUntil.set(OmieRateLimiter.key(appKey, method), this.now() + this.cfg.busyGapWindowMs);
  }

  /** Counts an Omie-side error; opens the key circuit before Omie's own block. */
  recordFailure(appKey: string, kind: FailureKind) {
    if (kind === "auth") {
      this.openKeyCircuit(appKey);
      return;
    }
    const cutoff = this.now() - this.cfg.keyErrorWindowMs;
    const list = (this.keyErrors.get(appKey) ?? []).filter((t) => t > cutoff);
    list.push(this.now());
    this.keyErrors.set(appKey, list);
    if (list.length >= this.cfg.keyErrorBudget) {
      this.openKeyCircuit(appKey);
      this.keyErrors.set(appKey, []);
    }
  }

  private prune(arr: number[]) {
    const cutoff = this.now() - WINDOW;
    while (arr.length && arr[0]! <= cutoff) arr.shift();
  }

  private pruneRequests() {
    if (this.lastRequest.size < 5_000) return;
    const cutoff = this.now() - this.cfg.redundantSpacingMs;
    for (const [fingerprint, at] of this.lastRequest)
      if (at < cutoff) this.lastRequest.delete(fingerprint);
  }

  private throwIfOpen(appKey: string, method: string) {
    const now = this.now();
    for (const scope of [method, KEY_SCOPE]) {
      const key = OmieRateLimiter.key(appKey, scope);
      const until = this.circuits.get(key);
      if (until && until > now) throw new CircuitOpenError(key, until);
    }
  }

  /**
   * Waits for a slot, runs fn, releases. Throws CircuitOpenError when open.
   * `fingerprint` identifies the exact request (method + params) so an identical
   * request is never sent twice inside the redundancy interval.
   */
  async run<T>(
    appKey: string,
    method: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    fingerprint?: string,
  ): Promise<T> {
    const k = OmieRateLimiter.key(appKey, method);
    this.throwIfOpen(appKey, method);
    if (fingerprint) {
      const last = this.lastRequest.get(fingerprint);
      const wait = last === undefined ? 0 : last + this.cfg.redundantSpacingMs - this.now();
      if (wait > 0) await abortableWait(this.sleep, wait, signal);
    }
    // One wait (not a loop) so injected clocks in tests never spin.
    const lastCall = this.lastMethodCall.get(k);
    const spacing =
      (this.busyUntil.get(k) ?? 0) > this.now()
        ? Math.max(this.cfg.minMethodGapMs, this.cfg.busyGapMs)
        : this.cfg.minMethodGapMs;
    const startAt = Math.max(
      lastCall === undefined ? 0 : lastCall + spacing,
      this.notBefore.get(k) ?? 0,
    );
    const gap = startAt - this.now();
    if (gap > 0) await abortableWait(this.sleep, gap, signal);
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      this.throwIfOpen(appKey, method);
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
      this.lastMethodCall.set(k, this.now());
      if (fingerprint) {
        this.pruneRequests();
        this.lastRequest.set(fingerprint, this.now());
      }
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

const envNumber = (env: Record<string, string | undefined>, name: string, fallback: number) => {
  const value = env[name];
  return value === undefined || value === "" ? fallback : Number(value);
};

/** One shared limiter per process; configure at first use, when server env is available. */
let sharedOmieLimiter: OmieRateLimiter | undefined;
export function getSharedOmieLimiter(): OmieRateLimiter {
  if (!sharedOmieLimiter) {
    const env = typeof process === "undefined" ? {} : process.env;
    sharedOmieLimiter = new OmieRateLimiter({
      globalPerMinute: envNumber(env, "OMIE_GLOBAL_PER_MINUTE", DEFAULT_RATE_LIMIT.globalPerMinute),
      perKeyMethodPerMinute: envNumber(
        env,
        "OMIE_KEY_METHOD_PER_MINUTE",
        DEFAULT_RATE_LIMIT.perKeyMethodPerMinute,
      ),
      maxConcurrentPerKeyMethod: envNumber(
        env,
        "OMIE_MAX_CONCURRENT",
        DEFAULT_RATE_LIMIT.maxConcurrentPerKeyMethod,
      ),
      circuitOpenMs: envNumber(env, "OMIE_CIRCUIT_OPEN_MS", DEFAULT_RATE_LIMIT.circuitOpenMs),
      redundantSpacingMs: envNumber(
        env,
        "OMIE_REDUNDANT_SPACING_MS",
        DEFAULT_RATE_LIMIT.redundantSpacingMs,
      ),
      keyErrorBudget: envNumber(env, "OMIE_KEY_ERROR_BUDGET", DEFAULT_RATE_LIMIT.keyErrorBudget),
      minMethodGapMs: envNumber(env, "OMIE_MIN_METHOD_GAP_MS", DEFAULT_RATE_LIMIT.minMethodGapMs),
      // 0 desliga a espera adaptativa (retorno sem nova release: variável + reinício do worker).
      emptyPageGapMs: envNumber(env, "OMIE_EMPTY_PAGE_GAP_MS", DEFAULT_RATE_LIMIT.emptyPageGapMs),
      busyGapMs: envNumber(env, "OMIE_BUSY_GAP_MS", DEFAULT_RATE_LIMIT.busyGapMs),
      busyGapWindowMs: envNumber(
        env,
        "OMIE_BUSY_GAP_WINDOW_MS",
        DEFAULT_RATE_LIMIT.busyGapWindowMs,
      ),
    });
  }
  return sharedOmieLimiter;
}
