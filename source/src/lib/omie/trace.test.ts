import { describe, expect, it } from "vitest";
import { classifyOmieAnswer, traceFetch, traceParams, type TraceEvent } from "./trace";

const body = (value: unknown) => JSON.stringify(value);

describe("rastreio do Omie", () => {
  it("classifica cada forma de resposta", () => {
    expect(classifyOmieAnswer(200, body({ total_de_paginas: 2, lista: [{}, {}] }))).toEqual({
      outcome: "ok",
      records: 2,
    });
    expect(
      classifyOmieAnswer(
        200,
        body({ pagina: 0, total_de_paginas: 0, total_de_registros: 0, lista: [] }),
      ),
    ).toEqual({ outcome: "empty-list", records: 0 });
    expect(
      classifyOmieAnswer(
        500,
        body({ faultstring: "ERROR: Não existem registros para a página [1]!" }),
      ),
    ).toEqual({ outcome: "empty-fault", records: 0 });
    expect(
      classifyOmieAnswer(
        500,
        body({ faultstring: "ERROR: Já existe uma requisição desse método sendo executada (1)" }),
      ).outcome,
    ).toBe("busy");
    expect(
      classifyOmieAnswer(500, body({ faultstring: "Consumo redundante detectado." })).outcome,
    ).toBe("redundant");
    expect(classifyOmieAnswer(425, "Too early").outcome).toBe("blocked");
    expect(classifyOmieAnswer(500, body({ faultstring: "Outro erro" })).outcome).toBe("fault");
    expect(classifyOmieAnswer(502, "<html>").outcome).toBe("not-json");
  });

  it("guarda só página e datas de filtro, nunca chave, segredo ou outros campos", () => {
    expect(
      traceParams({
        pagina: 1,
        registros_por_pagina: 100,
        filtrar_por_emissao_de: "25/08/2026",
        filtrar_por_emissao_ate: "26/10/2026",
        dDtPagtoDe: "25/08/2026",
        apenas_importado_api: "N",
        app_key: "KEY123",
        app_secret: "SECRET456",
        filtrar_por_cliente: "Cliente X",
      }),
    ).toEqual({
      pagina: 1,
      registros_por_pagina: 100,
      filtrar_por_emissao_de: "25/08/2026",
      filtrar_por_emissao_ate: "26/10/2026",
      dDtPagtoDe: "25/08/2026",
    });
  });

  it("registra a chamada sem credenciais e devolve a resposta intacta", async () => {
    const events: TraceEvent[] = [];
    let t = 1_000;
    const real = (async () =>
      new Response(body({ pagina: 0, total_de_paginas: 0, total_de_registros: 0, lista: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const traced = traceFetch(
      real,
      (e) => events.push(e),
      () => (t += 250),
    );
    const res = await traced("https://app.omie.com.br/api/v1/financas/mf/", {
      method: "POST",
      body: body({
        call: "ListarMovimentos",
        app_key: "KEY123",
        app_secret: "SECRET456",
        param: [{ nPagina: 1, dDtPagtoDe: "25/08/2026" }],
      }),
    });
    expect(await res.json()).toEqual({
      pagina: 0,
      total_de_paginas: 0,
      total_de_registros: 0,
      lista: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      call: "ListarMovimentos",
      outcome: "empty-list",
      records: 0,
      status: 200,
      ms: 250,
      params: { nPagina: 1, dDtPagtoDe: "25/08/2026" },
    });
    expect(JSON.stringify(events)).not.toMatch(/KEY123|SECRET456/);
  });

  it("deixa passar o que não é Omie sem registrar", async () => {
    const events: TraceEvent[] = [];
    const real = (async () => new Response("ok")) as unknown as typeof fetch;
    await traceFetch(real, (e) => events.push(e))("http://hml-gateway:8000/rest/v1/x");
    expect(events).toEqual([]);
  });
});
