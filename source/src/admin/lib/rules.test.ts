import { describe, expect, it } from "vitest";
import {
  accessErrors,
  describeVisibility,
  financeCapabilitiesFor,
  companiesGrantable,
  manageBlockReason,
  removesOwnAdmin,
  roleChangeBlockReason,
  rolesGrantableOnCreate,
  selfActionReason,
  usernameError,
} from "./rules";

const superA = { userId: "s", roles: ["SUPER_ADMIN" as const], companyIds: ["a", "b", "c"] };
const admin = { userId: "ad", roles: ["ADMIN" as const], companyIds: ["a", "b"] };

describe("regras do Admin", () => {
  it("Admin cria apenas papéis operacionais", () => {
    const r = rolesGrantableOnCreate(admin);
    expect(r).not.toContain("ADMIN");
    expect(r).not.toContain("SUPER_ADMIN");
    expect(r).toContain("VENDEDOR");
  });
  it("Admin só concede as próprias empresas", () => {
    expect(companiesGrantable(admin, ["a", "b", "c"])).toEqual(["a", "b"]);
  });
  it("Admin não gerencia usuário fora das empresas dele nem outro Admin", () => {
    expect(
      manageBlockReason(admin, { id: "x", roles: ["VIEWER"], companyIds: ["c"] }),
    ).not.toBeNull();
    expect(
      manageBlockReason(admin, { id: "y", roles: ["ADMIN"], companyIds: ["a"] }),
    ).not.toBeNull();
    expect(
      manageBlockReason(admin, { id: "z", roles: ["VENDEDOR"], companyIds: ["a"] }),
    ).toBeNull();
  });
  it("somente Super admin altera papéis", () => {
    expect(roleChangeBlockReason(admin)).toBe("Somente o Super admin altera papéis.");
    expect(roleChangeBlockReason(superA)).toBeNull();
  });
  it("ninguém remove o próprio admin, se bloqueia ou se exclui", () => {
    expect(removesOwnAdmin(superA, "s", ["VIEWER"])).toBe(true);
    expect(
      selfActionReason(superA, { id: "s", roles: [], companyIds: [] }, "block"),
    ).not.toBeNull();
    expect(
      selfActionReason(superA, { id: "s", roles: [], companyIds: [] }, "delete"),
    ).not.toBeNull();
  });
  it("Vendedor exige vendedor do Omie e ninguém fica sem papel", () => {
    expect(
      accessErrors({
        roles: ["VENDEDOR"],
        companyIds: ["a"],
        defaultCompanyId: "a",
        sellerIds: [],
      }),
    ).toContain("Vendedor precisa estar vinculado a um vendedor do Omie.");
    expect(
      accessErrors({ roles: [], companyIds: ["a"], defaultCompanyId: "a", sellerIds: [] }),
    ).toContain("Escolha pelo menos um papel.");
  });
  it("nome de usuário: 3 a 40, minúsculas, ponto ou hífen", () => {
    expect(usernameError("ab")).not.toBeNull();
    expect(usernameError("Joao")).not.toBeNull();
    expect(usernameError("joao.silva-2")).toBeNull();
  });
});

describe("o que a pessoa vê espelha o banco", () => {
  const name = (id: string) => ({ a: "Empresa A", b: "Empresa B" })[id] ?? id;
  it("financeiro por papel (public.finance_capabilities)", () => {
    expect(financeCapabilitiesFor(["VIEWER"], [])).toEqual([]);
    expect(financeCapabilitiesFor(["VENDEDOR"], [])).toEqual(["finance.view_summary"]);
    expect(financeCapabilitiesFor(["GESTOR"], [])).not.toContain("finance.export");
    expect(financeCapabilitiesFor(["ADMIN"], [])).toContain("finance.export");
    expect(financeCapabilitiesFor(["VIEWER"], ["finance.view_titles"])).toEqual([
      "finance.view_titles",
    ]);
  });
  it("Visualizador vê todos os vendedores e não vê o financeiro", () => {
    const t = describeVisibility({ roles: ["VIEWER"], companyIds: ["a"], permissions: [] }, name);
    expect(t).toContain("todos os vendedores");
    expect(t).toContain("Não vê o Financeiro");
  });
  it("Vendedor vê só os próprios números e o resumo financeiro", () => {
    const t = describeVisibility(
      { roles: ["VENDEDOR"], companyIds: ["a", "b"], permissions: [] },
      name,
    );
    expect(t).toContain("Vê Empresa A e Empresa B.");
    expect(t).toContain("Só os números do próprio vendedor.");
    expect(t).toContain("Do Financeiro, vê: Resumo financeiro.");
  });
  it("Admin vê o financeiro completo e administra usuários", () => {
    const t = describeVisibility({ roles: ["ADMIN"], companyIds: ["a"], permissions: [] }, name);
    expect(t).toContain("Vê o Financeiro completo.");
    expect(t).toContain("Administra os usuários");
  });
});
