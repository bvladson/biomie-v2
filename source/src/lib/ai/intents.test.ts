import { describe, expect, it } from "vitest";
import { explainIntentFor, normalize, routeIntent, suggestionsFor } from "./intents";

describe("routeIntent (regras fixas, sem modelo)", () => {
  it("vendedores antes de vendas", () => {
    expect(routeIntent("Quem vendeu mais em outubro?", "vendas")).toBe("ranking_vendedores");
    expect(routeIntent("ranking dos vendedores", "geral")).toBe("ranking_vendedores");
  });
  it("faturamento e comparação", () => {
    expect(routeIntent("quanto faturamos neste mês", "vendas")).toBe("faturamento_periodo");
    expect(routeIntent("como estamos contra o mes passado?", "vendas")).toBe("comparacao_periodos");
    expect(routeIntent("crescemos em relação ao ano passado?", "geral")).toBe(
      "comparacao_periodos",
    );
  });
  it("meta e ritmo", () => {
    expect(routeIntent("vamos bater a meta?", "plano")).toBe("ritmo_plano");
    expect(routeIntent("qual o ritmo necessario", "plano")).toBe("ritmo_plano");
  });
  it("estoque sem acento e oportunidades", () => {
    expect(routeIntent("o que esta parado no estoque", "estoque")).toBe("estoque_parado");
    expect(routeIntent("tem oportunidade de transferencia?", "estoque")).toBe(
      "oportunidades_estoque",
    );
  });
  it("clientes e produtos", () => {
    expect(routeIntent("quais os maiores clientes", "clientes")).toBe("ranking_clientes");
    expect(routeIntent("produto mais vendido", "produtos")).toBe("ranking_produtos");
  });
  it("explicação", () => {
    expect(routeIntent("me explica essa tela", "vendas")).toBe("explicar_tela");
  });
  it("fora do catálogo devolve null (a previsão do tempo da Fase 3)", () => {
    expect(routeIntent("qual a previsão do tempo amanhã?", "geral")).toBeNull();
    expect(routeIntent("ola, tudo bem?", "geral")).toBeNull();
  });
});

describe("apoios", () => {
  it("normalize tira acento e caixa", () => {
    expect(normalize("  Previsão do TEMPO ")).toBe("previsao do tempo");
  });
  it("explicar da tela de estoque usa o pacote do estoque", () => {
    expect(explainIntentFor("estoque")).toBe("estoque_parado");
    expect(explainIntentFor("vendas")).toBe("explicar_tela");
  });
  it("cada tela tem 3 sugestões com intenção marcada", () => {
    for (const topic of [
      "geral",
      "vendas",
      "vendedores",
      "plano",
      "estoque",
      "clientes",
      "produtos",
    ] as const) {
      const s = suggestionsFor(topic);
      expect(s.length).toBe(3);
      expect(s[0]!.label).toBe("Explicar esta tela");
    }
  });
});
