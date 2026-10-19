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
  it("incomplete page fails", async () => {
    const { client } = mk([() => json({ total_de_paginas: 1, registros: 5, lista: [{}] })]);
    await expect(client.listPage("x/", "L", { pagina: 1 }, ["lista"])).rejects.toMatchObject({
      kind: "incomplete",
    });
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
