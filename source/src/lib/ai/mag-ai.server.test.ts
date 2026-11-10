import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "magai_biomie_" + "A".repeat(43);

async function fresh() {
  vi.resetModules();
  return import("./mag-ai.server");
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  process.env["MAG_AI_URL"] = "http://mag-ai:8080";
  process.env["MAG_AI_KEY"] = KEY;
});
afterEach(() => {
  delete process.env["MAG_AI_URL"];
  delete process.env["MAG_AI_KEY"];
  vi.unstubAllGlobals();
});

describe("magAiChat", () => {
  it("sem configuração devolve indisponível (o balão nem chama)", async () => {
    delete process.env["MAG_AI_KEY"];
    const { magAiChat } = await fresh();
    const r = await magAiChat({ task: "responder", system: "s", user: "u" });
    expect(r).toMatchObject({ ok: false, code: "indisponivel" });
  });

  it("monta o pedido do contrato do gateway e lê a resposta", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(
        respond(200, {
          id: "r1",
          model: "qwen3.5:0.8b-q8_0",
          content: " Resposta. ",
          usage: { prompt_tokens: 900, output_tokens: 80 },
          timings: { queue_ms: 12 },
        }),
      );
    });
    const { magAiChat } = await fresh();
    const r = await magAiChat({
      task: "responder",
      system: "REGRAS",
      user: "FATOS",
      maxTokens: 220,
    });
    expect(r).toMatchObject({
      ok: true,
      content: "Resposta.",
      model: "qwen3.5:0.8b-q8_0",
      promptTokens: 900,
    });
    expect(seen!.url).toBe("http://mag-ai:8080/v1/chat");
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toMatchObject({ task: "responder", stream: false, max_tokens: 220 });
    expect(body.messages[0]).toEqual({ role: "system", content: "REGRAS" });
    expect((seen!.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("mapeia limite (429), ocupado (503 curto) e indisponível (503 longo)", async () => {
    const answers = [
      respond(429, { error: { code: "rate_limited" } }, { "retry-after": "10" }),
      respond(503, { error: { code: "busy" } }, { "retry-after": "5" }),
      respond(503, { error: { code: "upstream_unavailable" } }, { "retry-after": "60" }),
    ];
    vi.stubGlobal("fetch", () => Promise.resolve(answers.shift()!));
    const { magAiChat } = await fresh();
    expect((await magAiChat({ task: "responder", system: "s", user: "u" })).ok).toBe(false);
    const ocupado = await magAiChat({ task: "responder", system: "s", user: "u" });
    expect(ocupado).toMatchObject({ ok: false, code: "ocupado", retryAfterS: 5 });
    expect(await magAiChat({ task: "responder", system: "s", user: "u" })).toMatchObject({
      ok: false,
      code: "indisponivel",
    });
  });

  it("3 falhas de rede abrem o disjuntor (a 4ª nem tenta)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return Promise.reject(new Error("rede"));
    });
    const { magAiChat } = await fresh();
    for (let i = 0; i < 3; i += 1) await magAiChat({ task: "responder", system: "s", user: "u" });
    const r = await magAiChat({ task: "responder", system: "s", user: "u" });
    expect(calls).toBe(3);
    expect(r).toMatchObject({ ok: false, code: "indisponivel" });
  });

  it("resposta sem conteúdo vira erro", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(respond(200, { id: "x" })));
    const { magAiChat } = await fresh();
    expect(await magAiChat({ task: "responder", system: "s", user: "u" })).toMatchObject({
      ok: false,
      code: "erro",
    });
  });
});

describe("magAiHealth", () => {
  it("lê o health do gateway", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(respond(200, { status: "ok", ollama: "up", model_loaded: false, queue: 0 })),
    );
    const { magAiHealth } = await fresh();
    expect(await magAiHealth()).toEqual({ status: "ok", modelLoaded: false, queue: 0 });
  });

  it("gateway fora do ar devolve null", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("rede")));
    const { magAiHealth } = await fresh();
    expect(await magAiHealth()).toBeNull();
  });
});
