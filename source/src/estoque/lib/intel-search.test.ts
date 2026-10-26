import { describe, expect, it } from "vitest";
import { CLEAR, fromSearch, toQuery, toSearch, validateIntelSearch } from "./intel-search";

describe("inteligência do estoque — filtros no endereço", () => {
  it("aceita só valores conhecidos e descarta o resto", () => {
    expect(
      validateIntelSearch({
        estado: "risco_ruptura",
        sinal: "custo_provisorio",
        curva: "D",
        faixa: "365+",
        semVenda: 180,
        busca: "  mesa ",
        ordem: "capital",
        sentido: "asc",
        pagina: 3,
      }),
    ).toEqual({
      estado: "risco_ruptura",
      sinal: "custo_provisorio",
      curva: "D",
      faixa: "365+",
      semVenda: 180,
      busca: "mesa",
      ordem: "capital",
      sentido: "asc",
      pagina: 3,
    });
    const bad = validateIntelSearch({
      estado: "CE", // UF do filtro global: não é estado de estoque
      sinal: "constructor",
      curva: "U",
      faixa: "10-20",
      semVenda: 45,
      busca: "x".repeat(121),
      ordem: "preco",
      sentido: "up",
      pagina: 0,
    });
    expect(Object.values(bad).every((v) => v === undefined)).toBe(true);
    expect(validateIntelSearch({ semVenda: "180", pagina: 1.5 })).toEqual(
      expect.objectContaining({ semVenda: undefined, pagina: undefined }),
    );
  });

  it("converte nos dois sentidos e só mexe nas chaves pedidas", () => {
    expect(fromSearch({ estado: "novo", pagina: 2 })).toEqual(
      expect.objectContaining({ state: "novo", page: 2, flag: undefined }),
    );
    expect(toSearch({ state: "novo", page: undefined })).toEqual({
      estado: "novo",
      pagina: undefined,
    });
    expect(Object.keys(toSearch(CLEAR)).sort()).toEqual(
      [
        "busca",
        "comAlerta",
        "curva",
        "estado",
        "faixa",
        "ordem",
        "pagina",
        "recomendacao",
        "semVenda",
        "sentido",
        "sinal",
      ].sort(),
    );
  });

  it("recomendação, só com alerta e aba: só valores conhecidos", () => {
    expect(
      validateIntelSearch({ recomendacao: "comprar", comAlerta: true, aba: "reposicao" }),
    ).toEqual(
      expect.objectContaining({ recomendacao: "comprar", comAlerta: true, aba: "reposicao" }),
    );
    expect(
      validateIntelSearch({ recomendacao: "vender_tudo", comAlerta: "true", aba: "admin" }),
    ).toEqual(
      expect.objectContaining({ recomendacao: undefined, comAlerta: undefined, aba: undefined }),
    );
    expect(toQuery("all", fromSearch({ recomendacao: "nao_comprar", comAlerta: true }))).toEqual(
      expect.objectContaining({ rec: "nao_comprar", withAlerts: true }),
    );
  });
});
