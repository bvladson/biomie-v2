import { describe, expect, it } from "vitest";
import { fallbackText, numbersOf, readingsOf, verifyAnswer } from "./verify";

const FACTS = [
  "FATOS — MAG Filial, Novembro / 2026, dados de 10/11/2026:",
  "Faturamento do mês até agora: R$ 412.350",
  "Meta do mês: R$ 450.000",
  "Percentual da meta atingido: 91,6%",
  "Meta batida: AINDA NÃO (faltam R$ 37.650)",
  "Notas emitidas: 37; ticket médio: R$ 11.145",
  "Clientes atendidos: 214 (novos: 5)",
];

describe("readingsOf", () => {
  it("lê os formatos do Brasil e os ambíguos", () => {
    expect(readingsOf("1.234,56")).toEqual([1234.56]);
    expect(readingsOf("91,6")).toEqual([91.6]);
    expect(readingsOf("1.503")).toEqual(expect.arrayContaining([1503, 1.503]));
    expect(readingsOf("412.350")).toContain(412350);
    expect(readingsOf("12")).toEqual([12]);
  });
});

describe("verifyAnswer", () => {
  it("aceita resposta que só copia números dos fatos", () => {
    const r = verifyAnswer(
      "O faturamento é R$ 412.350, com 91,6% da meta de R$ 450.000. Faltam R$ 37.650.",
      FACTS,
    );
    expect(r).toEqual({ ok: true, flagged: [] });
  });

  it("descarta número inventado (a margem de 10,2% da Fase 3)", () => {
    const r = verifyAnswer("A margem de lucro foi de 10,2%.", FACTS);
    expect(r.ok).toBe(false);
    expect(r.flagged).toContain("10,2");
  });

  it("descarta soma feita pelo modelo", () => {
    const r = verifyAnswer("Juntos, faturamento e meta somam R$ 862.350.", FACTS);
    expect(r.ok).toBe(false);
  });

  it("tolera inteiros pequenos, anos e arredondamento de percentual", () => {
    expect(verifyAnswer("Foram 5 clientes novos em 2026, cerca de 92% da meta.", FACTS).ok).toBe(
      true,
    );
  });

  it("aceita data que está nos fatos e número dentro dela", () => {
    expect(verifyAnswer("Os dados são de 10/11/2026.", FACTS).ok).toBe(true);
  });

  it("numbersOf cobre os fatos inteiros", () => {
    const all = numbersOf(FACTS.join("\n"));
    expect(all).toContain(412350);
    expect(all).toContain(91.6);
    expect(all).toContain(37);
  });

  it("fallbackText lista os fatos", () => {
    const text = fallbackText(FACTS);
    expect(text).toContain("resposta segura");
    expect(text).toContain("R$ 412.350");
  });
});
