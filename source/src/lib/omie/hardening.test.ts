import { describe, expect, it } from "vitest";
import { invoicesAdapter } from "./adapters";
import { emptyTxCheckpoint, parseTxCheckpoint, partitionProven } from "./checkpoint";
import { OmieClient } from "./omie-client";
import { OmieRateLimiter } from "./rate-limiter";

const creds = { appKey: "test-key", appSecret: "test-secret" };
const invoice = (status?: string) => ({
  compl: { nIdNF: 1 },
  ide: { nNF: "1", dEmi: "19/10/2026", ...(status ? { cStatus: status } : {}) },
  total: { ICMSTot: { vNF: 100 } },
});

describe("fiscal evidence", () => {
  it("does not turn missing or unknown authorization into revenue", () => {
    expect(invoicesAdapter.toCanonical(invoice())).toBeNull();
    expect(invoicesAdapter.toCanonical(invoice("999"))).toBeNull();
    expect(invoicesAdapter.toRaw(invoice())).not.toBeNull();
  });
  it("keeps authorization, cancellation and denial distinct", () => {
    expect(invoicesAdapter.toCanonical(invoice("100"))?.header["status"]).toBe("authorized");
    expect(invoicesAdapter.toCanonical(invoice("101"))?.header["status"]).toBe("cancelled");
    expect(invoicesAdapter.toCanonical(invoice("301"))?.header["status"]).toBe("denied");
  });
});

describe("durable transactional pagination", () => {
  it("retains monthly totals across the JSON checkpoint boundary", () => {
    const checkpoint = {
      ...emptyTxCheckpoint(),
      page: 3,
      totalPages: 3,
      expected: 250,
      received: 200,
    };
    const restored = parseTxCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    expect(restored?.expected).toBe(250);
    expect(partitionProven(restored!, 3, 3)).toBe(false);
    expect(partitionProven({ ...restored!, received: 250 }, 3, 3)).toBe(true);
    expect(partitionProven({ ...restored!, received: 251 }, 3, 3)).toBe(false);
  });
  it("replays an old checkpoint instead of inventing missing pagination proof", () => {
    expect(parseTxCheckpoint({ partition: 2, page: 5, proven: [true] })).toBeNull();
    expect(parseTxCheckpoint({ ...emptyTxCheckpoint(), received: -1 })).toBeNull();
  });
});

describe("Omie HTTP bounds", () => {
  it("rejects a response for a different page", async () => {
    const client = new OmieClient(creds, {
      maxRetries: 0,
      limiter: new OmieRateLimiter(),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ pagina: 1, total_de_paginas: 2, registros: 1, lista: [{}] }),
        )) as typeof fetch,
    });
    await expect(client.listPage("x/", "Listar", { pagina: 2 }, ["lista"])).rejects.toMatchObject({
      kind: "incomplete",
    });
  });

  it("includes a stalled response body in the HTTP timeout", async () => {
    const fetchImpl = (async (_url: unknown, init: RequestInit) => ({
      text: () =>
        new Promise<string>((_resolve, reject) =>
          init.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    })) as unknown as typeof fetch;
    const client = new OmieClient(creds, {
      timeoutMs: 10,
      maxRetries: 0,
      fetchImpl,
      limiter: new OmieRateLimiter(),
    });
    await expect(client.call("x/", "Listar", {})).rejects.toMatchObject({ kind: "timeout" });
  });

  it("obeys Retry-After on a rate limited request", async () => {
    const waits: number[] = [];
    let request = 0;
    const client = new OmieClient(creds, {
      fetchImpl: (async () =>
        ++request === 1
          ? new Response("{}", { status: 429, headers: { "Retry-After": "10" } })
          : new Response("{}")) as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      limiter: new OmieRateLimiter(),
    });
    await client.call("x/", "Listar", {});
    expect(waits[0]).toBeGreaterThanOrEqual(10_000);
  });
});
