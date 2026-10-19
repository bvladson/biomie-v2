import { describe, expect, it } from "vitest";
import { OmieClient, OmieError, redact } from "./omie-client";
import { OmieRateLimiter } from "./rate-limiter";

const creds = { appKey: "KEY123", appSecret: "SECRET456" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mk(
  responses: (() => Response)[],
  limiter = new OmieRateLimiter({}, { sleep: async () => {} }),
) {
  let i = 0;
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n++;
    return responses[Math.min(i++, responses.length - 1)]!();
  }) as unknown as typeof fetch;
  return {
    client: new OmieClient(creds, { fetchImpl, sleep: async () => {}, limiter, maxRetries: 3 }),
    calls,
    limiter,
  };
}

describe("OmieClient", () => {
  it("retries 429 with backoff then succeeds", async () => {
    const { client, calls } = mk([
      () => json({}, 429),
      () => json({ total_de_paginas: 1, registros: 1, lista: [{ a: 1 }] }),
    ]);
    const p = await client.listPage("x/", "Listar", { pagina: 1 }, ["lista"]);
    expect(p.records).toHaveLength(1);
    expect(calls.n).toBe(2);
  });
  it("425 opens circuit without retry and blocks further calls", async () => {
    const { client, calls, limiter } = mk([() => json({}, 425)]);
    await expect(client.call("x/", "ListarNF", {})).rejects.toMatchObject({ kind: "blocked" });
    expect(calls.n).toBe(1);
    expect(limiter.circuitState("KEY123", "ListarNF")).toBe("open");
    await expect(client.call("x/", "ListarNF", {})).rejects.toBeInstanceOf(OmieError);
    expect(calls.n).toBe(1);
  });
  it("permanent client error is not retried", async () => {
    const { client, calls } = mk([() => json({ faultstring: "Parâmetro inválido" }, 500)]);
    await expect(client.call("x/", "L", {})).rejects.toMatchObject({ kind: "client" });
    expect(calls.n).toBe(1);
  });
  it("empty page returns no records", async () => {
    const { client } = mk([
      () => json({ faultstring: "Não existem registros para a página [3]!" }, 500),
    ]);
    const p = await client.listPage("x/", "L", { pagina: 3 }, ["lista"]);
    expect(p.records).toEqual([]);
  });
  it("accepts Omie's real empty answer (pagina 0, no records) as an empty first page", async () => {
    const { client } = mk([
      () =>
        json({
          pagina: 0,
          total_de_paginas: 0,
          registros: 0,
          total_de_registros: 0,
          nfCadastro: [],
        }),
    ]);
    const p = await client.listPage("x/", "ListarNF", { pagina: 1 }, ["nfCadastro"]);
    expect(p).toEqual({ page: 1, totalPages: 0, totalRecords: 0, records: [] });
  });
  it("still rejects a wrong page number when there are records", async () => {
    const { client } = mk([
      () => json({ pagina: 0, total_de_paginas: 1, registros: 1, nfCadastro: [{ a: 1 }] }),
    ]);
    await expect(
      client.listPage("x/", "ListarNF", { pagina: 1 }, ["nfCadastro"]),
    ).rejects.toMatchObject({ kind: "incomplete" });
  });
  it("incomplete page fails", async () => {
    const { client } = mk([() => json({ total_de_paginas: 1, registros: 5, lista: [{}] })]);
    await expect(client.listPage("x/", "L", { pagina: 1 }, ["lista"])).rejects.toMatchObject({
      kind: "incomplete",
    });
  });
  it("waits at least 61 s before retrying a redundant-consumption fault", async () => {
    const waits: number[] = [];
    let i = 0;
    const responses = [
      () => json({ faultstring: "ERROR: Consumo redundante detectado. Aguarde 60 segundos." }, 500),
      () => json({ total_de_paginas: 1, registros: 1, lista: [{ a: 1 }] }),
    ];
    const client = new OmieClient(creds, {
      fetchImpl: (async () => responses[Math.min(i++, 1)]!()) as unknown as typeof fetch,
      sleep: async (ms) => void waits.push(ms),
      limiter: new OmieRateLimiter({}, { sleep: async () => {} }),
      maxRetries: 2,
    });
    await client.listPage("x/", "ListarNF", { pagina: 1 }, ["lista"]);
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(61_000);
  });

  it("retries a busy-method fault after at least 20 s instead of failing the load", async () => {
    const waits: number[] = [];
    let i = 0;
    const responses = [
      () =>
        json(
          {
            faultstring:
              "ERROR: Já existe uma requisição desse método sendo executada e você pode tentar novamente em alguns instantes. (1)",
          },
          500,
        ),
      () => json({ total_de_paginas: 1, registros: 1, lista: [{ a: 1 }] }),
    ];
    const client = new OmieClient(creds, {
      fetchImpl: (async () => responses[Math.min(i++, 1)]!()) as unknown as typeof fetch,
      sleep: async (ms) => void waits.push(ms),
      limiter: new OmieRateLimiter({}, { sleep: async () => {} }),
      maxRetries: 2,
    });
    const page = await client.listPage("x/", "ListarContasReceber", { pagina: 1 }, ["lista"]);
    expect(page.records).toHaveLength(1);
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(20_000);
  });

  it("redacts credentials", () => {
    const m = redact('erro KEY123 / SECRET456 "app_key":"zzz"', creds);
    expect(m).not.toContain("KEY123");
    expect(m).not.toContain("SECRET456");
    expect(m).not.toContain("zzz");
  });
});

describe("OmieRateLimiter", () => {
  it("respects per key+method cap and method overrides", async () => {
    let t = 0;
    const waits: number[] = [];
    const l = new OmieRateLimiter(
      { perKeyMethodPerMinute: 2, methodOverrides: { Slow: 1 } },
      {
        now: () => t,
        sleep: async (ms) => {
          waits.push(ms);
          t += ms;
        },
      },
    );
    await l.run("k", "A", async () => 1);
    await l.run("k", "A", async () => 1);
    await l.run("k", "A", async () => 1);
    expect(t).toBeGreaterThanOrEqual(60_000);
    expect(l.limitFor("Slow")).toBe(1);
  });
  it("spaces identical requests by at least 61 s and never delays different ones", async () => {
    let t = 0;
    const waits: number[] = [];
    const l = new OmieRateLimiter(
      { minMethodGapMs: 0 },
      {
        now: () => t,
        sleep: async (ms) => {
          waits.push(ms);
          t += ms;
        },
      },
    );
    await l.run("k", "ListarNF", async () => 1, undefined, "page-1");
    await l.run("k", "ListarNF", async () => 1, undefined, "page-2");
    expect(waits).toEqual([]);
    await l.run("k", "ListarNF", async () => 1, undefined, "page-1");
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(61_000);
  });

  it("pauses between consecutive calls of the same method and key only", async () => {
    let t = 0;
    const waits: number[] = [];
    const l = new OmieRateLimiter(
      {},
      {
        now: () => t,
        sleep: async (ms) => {
          waits.push(ms);
          t += ms;
        },
      },
    );
    await l.run("k", "ListarContasReceber", async () => 1, undefined, "k-crr-1");
    await l.run("k", "ListarContasReceber", async () => 1, undefined, "k-crr-2");
    expect(waits).toEqual([2_000]);
    await l.run("k", "ListarMovimentos", async () => 1, undefined, "k-mov-1");
    await l.run("other", "ListarContasReceber", async () => 1, undefined, "other-crr-1");
    expect(waits).toEqual([2_000]);
    t += 5_000;
    await l.run("k", "ListarContasReceber", async () => 1, undefined, "k-crr-3");
    expect(waits).toEqual([2_000]);
  });

  it("opens a 30-minute circuit by default", () => {
    let t = 0;
    const l = new OmieRateLimiter({}, { now: () => t });
    l.openCircuit("k", "ListarNF");
    t += 29 * 60_000;
    expect(l.circuitState("k", "ListarNF")).toBe("open");
    t += 2 * 60_000;
    expect(l.circuitState("k", "ListarNF")).toBe("closed");
  });

  it("pauses the whole App Key on invalid credentials and after the error budget", async () => {
    const t = 0;
    const l = new OmieRateLimiter({ keyErrorBudget: 3 }, { now: () => t });
    l.recordFailure("bad", "auth");
    expect(l.circuitState("bad", "ListarClientes")).toBe("open");
    await expect(l.run("bad", "ListarPedidos", async () => 1)).rejects.toThrow(/bloqueado/);
    l.recordFailure("k", "client");
    l.recordFailure("k", "client");
    expect(l.circuitState("k", "Any")).toBe("closed");
    l.recordFailure("k", "client");
    expect(l.circuitState("k", "Any")).toBe("open");
  });

  it("respects global cap across keys", async () => {
    let t = 0;
    const l = new OmieRateLimiter(
      { globalPerMinute: 2 },
      {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );
    await l.run("a", "M", async () => 1);
    await l.run("b", "M", async () => 1);
    await l.run("c", "M", async () => 1);
    expect(t).toBeGreaterThanOrEqual(60_000);
  });
});
