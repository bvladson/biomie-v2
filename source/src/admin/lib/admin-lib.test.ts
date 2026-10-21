import { describe, expect, it } from "vitest";
import { monthWorkdays, parseHolidayList } from "./workdays";
import { describeChanges, sanitizePayload } from "./audit";
import { passwordStrength } from "./password";

describe("dias úteis", () => {
  it("conta segunda a sexta menos feriados (out/2026 com 12/10 feriado = 21)", () => {
    expect(monthWorkdays(2026, 9, [{ date: "2026-10-12" }], "2026-01-01").total).toBe(21);
  });
  it("restantes contam a partir de hoje (21/10/2026, quarta → 8 dias úteis)", () => {
    expect(monthWorkdays(2026, 9, [{ date: "2026-10-12" }], "2026-10-21").remaining).toBe(8);
  });
  it("mês passado tem 0 restantes", () => {
    expect(monthWorkdays(2026, 8, [], "2026-10-21").remaining).toBe(0);
  });
});

describe("importação de feriados", () => {
  it("marca duplicados existentes e repetidos na lista", () => {
    const r = parseHolidayList("01/01/2027;Ano-Novo\n01/01/2027;Repetido\n25/12/2026;Natal", [
      "2026-12-25",
    ]);
    expect(r.map((x) => x.duplicate)).toEqual([false, true, true]);
  });
  it("rejeita data inexistente e formato errado", () => {
    const r = parseHolidayList("31/02/2027;X\n2027-01-01 Ano", []);
    expect(r[0]?.error).toBe("Data inexistente");
    expect(r[1]?.error).toMatch(/Formato/);
  });
});

describe("auditoria nunca exibe segredo", () => {
  it("remove senha, link e token do payload", () => {
    expect(sanitizePayload({ senha: "x", link: "y", token: "z", validoAte: "2026" })).toEqual({
      validoAte: "2026",
    });
  });
  it("descreve antes e depois em linguagem legível", () => {
    const lines = describeChanges(
      {
        id: 1,
        at: "",
        actorId: null,
        actorName: "",
        action: "role.granted",
        entity: "user",
        entityId: null,
        companyId: null,
        before: { papeis: ["VENDEDOR"] },
        after: { papeis: ["VENDEDOR", "GESTOR"], senha: "segredo" },
      },
      (id) => id,
    );
    expect(lines).toEqual([{ field: "Papéis", before: "VENDEDOR", after: "VENDEDOR, GESTOR" }]);
  });
});

describe("senha", () => {
  it("menos de 10 caracteres nunca passa de Fraca", () => {
    expect(passwordStrength("Ab1!xyz").score).toBeLessThanOrEqual(1);
  });
});
