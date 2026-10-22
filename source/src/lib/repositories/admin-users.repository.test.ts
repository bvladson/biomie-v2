import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AdminUser } from "@/admin/api/contract";

const { admin, signIn } = vi.hoisted(() => ({
  admin: {
    generateLink: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    updateUserById: vi.fn(),
    getUserById: vi.fn(),
    signOut: vi.fn(),
  },
  signIn: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { auth: { admin } } }));
vi.mock("./auth.repository.server", () => ({ signInWithLegacyIdentifier: signIn }));

import * as repo from "./admin-users.repository.server";

type Reply = { data?: unknown; error?: { message: string; code?: string } };
function fakeDb(handlers: Record<string, (args: Record<string, unknown>) => Reply>) {
  const calls: string[] = [];
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push(fn);
      const handler = handlers[fn];
      if (!handler) throw new Error(`rpc inesperada: ${fn}`);
      const r = handler(args);
      return { data: r.data ?? null, error: r.error ?? null };
    }),
  };
  return { db: db as unknown as SupabaseClient<Database>, calls };
}

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: "u1",
  fullName: "José da Silva",
  email: "jose@exemplo.com.br",
  username: null,
  roles: ["VENDEDOR"],
  companyIds: ["c1"],
  defaultCompanyId: "c1",
  sellerIds: ["s1"],
  managedTeamIds: [],
  permissions: [],
  status: "ACTIVE",
  createdAt: "2026-10-01T00:00:00Z",
  lastSignInAt: "2026-10-20T00:00:00Z",
  blockedReason: null,
  otherCompanyCount: 0,
  legacyUsernames: [],
  ...over,
});

const input = {
  fullName: "Ana Souza",
  email: " Ana@Exemplo.com.br ",
  roles: ["VENDEDOR" as const],
  companyIds: ["c1"],
  defaultCompanyId: "c1",
  sellerIds: ["s1"],
  delivery: "INVITE_LINK" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env["APP_BASE_URL"] = "https://biomie.exemplo.com.br/";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("criação de usuário", () => {
  it("regra recusada no banco não chega ao serviço de login", async () => {
    const { db } = fakeDb({
      admin_validate_new_user: () => ({
        error: { message: "E-mail já cadastrado.", code: "P0001" },
      }),
    });
    await expect(repo.createUser(db, input)).rejects.toThrow("E-mail já cadastrado.");
    expect(admin.generateLink).not.toHaveBeenCalled();
    expect(admin.createUser).not.toHaveBeenCalled();
  });

  it("convite: link de uso único para a página de senha e configuração com o mesmo prazo", async () => {
    admin.generateLink.mockResolvedValue({
      data: { user: { id: "new" }, properties: { action_link: "https://link/único" } },
      error: null,
    });
    let provisioned: Record<string, unknown> = {};
    const { db, calls } = fakeDb({
      admin_validate_new_user: () => ({}),
      admin_provision_user: (args) => {
        provisioned = args;
        return { data: user({ id: "new", status: "INVITED" }) };
      },
    });
    const r = await repo.createUser(db, input);
    expect(calls).toEqual(["admin_validate_new_user", "admin_provision_user"]);
    expect(admin.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invite",
        email: "ana@exemplo.com.br",
        options: expect.objectContaining({
          redirectTo: "https://biomie.exemplo.com.br/reset-password",
        }),
      }),
    );
    expect(r.secret).toMatchObject({ kind: "INVITE_LINK", value: "https://link/único" });
    expect((provisioned["p_payload"] as { expiresAt: string }).expiresAt).toBe(r.secret.expiresAt);
  });

  it("se a configuração falha, a conta recém-criada é apagada", async () => {
    admin.generateLink.mockResolvedValue({
      data: { user: { id: "new" }, properties: { action_link: "https://link" } },
      error: null,
    });
    admin.deleteUser.mockResolvedValue({ error: null });
    const { db } = fakeDb({
      admin_validate_new_user: () => ({}),
      admin_provision_user: () => ({
        error: { message: "Vendedor A1 já tem login vinculado.", code: "P0001" },
      }),
    });
    await expect(repo.createUser(db, input)).rejects.toThrow("já tem login vinculado");
    expect(admin.deleteUser).toHaveBeenCalledWith("new");
  });

  it("senha temporária: troca obrigatória marcada onde só o servidor altera", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "new" } }, error: null });
    const { db } = fakeDb({
      admin_validate_new_user: () => ({}),
      admin_provision_user: () => ({ data: user({ id: "new" }) }),
    });
    const r = await repo.createUser(db, { ...input, delivery: "TEMP_PASSWORD" });
    const call = admin.createUser.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["app_metadata"]).toMatchObject({ must_change_password: true });
    expect(call["user_metadata"]).not.toHaveProperty("must_change_password");
    expect(call["password"]).toBe(r.secret.value);
  });
});

describe("ações no serviço de login", () => {
  it("sem permissão no banco, nada é gerado", async () => {
    const { db } = fakeDb({ admin_check_action: () => ({ data: "Usuário não encontrado." }) });
    await expect(repo.issueAccess(db, "u1", "INVITE_LINK")).rejects.toThrow(
      "Usuário não encontrado.",
    );
    expect(admin.generateLink).not.toHaveBeenCalled();
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });

  it("bloqueio sem registro no banco é desfeito", async () => {
    admin.updateUserById.mockResolvedValue({ error: null });
    const { db } = fakeDb({
      admin_check_action: () => ({ data: null }),
      admin_block_recorded: () => ({ error: { message: "boom", code: "XX000" } }),
    });
    await expect(repo.setBlocked(db, "u1", true, "Saiu da empresa")).rejects.toThrow(
      "Não foi possível concluir a operação",
    );
    expect(
      admin.updateUserById.mock.calls.map((c) => (c[1] as { ban_duration: string }).ban_duration),
    ).toEqual(["876000h", "none"]);
  });

  it("exclusão: o banco retira o acesso antes; se recusar, a conta fica", async () => {
    const refused = fakeDb({
      admin_delete_user: () => ({
        error: { message: "O e-mail digitado não confere.", code: "P0001" },
      }),
    });
    await expect(repo.deleteUser(refused.db, "u1", "x")).rejects.toThrow("não confere");
    expect(admin.deleteUser).not.toHaveBeenCalled();
    admin.deleteUser.mockResolvedValue({ error: null });
    const ok = fakeDb({ admin_delete_user: () => ({}) });
    await repo.deleteUser(ok.db, "u1", "jose@exemplo.com.br");
    expect(admin.deleteUser).toHaveBeenCalledWith("u1", true);
  });
});

describe("minha conta", () => {
  it("senha atual errada não altera nada", async () => {
    signIn.mockRejectedValue(new Error("x"));
    const { db } = fakeDb({});
    await expect(
      repo.changeMyPassword(db, { id: "u-senha", email: "a@b.c" }, "errada", "NovaSenha!2026"),
    ).rejects.toThrow("Senha atual incorreta.");
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });

  it("senha temporária expirada não é trocada pelo primeiro acesso", async () => {
    admin.getUserById.mockResolvedValue({
      data: {
        user: {
          app_metadata: {
            must_change_password: true,
            temp_password_expires_at: "2020-01-01T00:00:00Z",
          },
        },
      },
      error: null,
    });
    const { db } = fakeDb({});
    await expect(repo.completeFirstPassword(db, "u1", "NovaSenha!2026")).rejects.toThrow("expirou");
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });
});

describe("auxiliares", () => {
  it("busca sem acento em nome, e-mail e apelidos, com filtros e página", () => {
    const all = [
      user({ id: "a", fullName: "José Antônio" }),
      user({
        id: "b",
        fullName: "Maria",
        legacyUsernames: ["mlima"],
        roles: ["VIEWER"],
        status: "BLOCKED",
      }),
      user({ id: "c", fullName: "Carlos", companyIds: ["c2"] }),
    ];
    expect(repo.filterUsers(all, { search: "jose antonio" }).rows.map((u) => u.id)).toEqual(["a"]);
    expect(repo.filterUsers(all, { search: "MLIMA" }).rows.map((u) => u.id)).toEqual(["b"]);
    expect(repo.filterUsers(all, { role: "VIEWER", status: "BLOCKED" }).total).toBe(1);
    expect(repo.filterUsers(all, { companyId: "c2" }).rows.map((u) => u.id)).toEqual(["c"]);
    expect(repo.filterUsers(all, { page: 2, pageSize: 2 })).toMatchObject({
      total: 3,
      rows: [{ id: "c" }],
    });
  });

  it("só mensagens escritas para a tela chegam ao usuário", () => {
    expect(
      repo.userFacingError({ message: "Somente o Super admin altera papéis.", code: "42501" })
        .message,
    ).toBe("Somente o Super admin altera papéis.");
    expect(
      repo.userFacingError({ message: "permission denied for table x", code: "42501" }).message,
    ).toMatch(/^Não foi possível concluir/);
    expect(repo.userFacingError({ message: "duplicate key value", code: "23505" }).message).toMatch(
      /^Não foi possível concluir/,
    );
  });

  it("senha temporária legível, com as quatro classes e diferente a cada vez", () => {
    const a = repo.generateTempPassword();
    expect(a).toMatch(/^[A-Z][A-Za-z2-9]{3}-[a-z][A-Za-z2-9]{3}-[2-9][A-Za-z2-9]{3}[!@#%*?]$/);
    expect(a).not.toMatch(/[0O1lI]/);
    expect(repo.generateTempPassword()).not.toBe(a);
  });

  it("nova senha: mínimo de 10 e diferente da atual", () => {
    expect(() => repo.validateNewPassword("curta")).toThrow("10 caracteres");
    expect(() => repo.validateNewPassword("MesmaSenha123", "MesmaSenha123")).toThrow("diferente");
    expect(() => repo.validateNewPassword("OutraSenha123", "MesmaSenha123")).not.toThrow();
  });
});

describe("link de acesso", () => {
  const publicApi = "https://biomie.exemplo.com.br/supabase";
  const lost = "https://biomie.exemplo.com.br/auth/v1/verify?token=t1&type=invite";

  it("fica sob o endereço público da API, mesmo quando o serviço de login perde o /supabase", () => {
    process.env["PUBLIC_SUPABASE_URL"] = `${publicApi}/`;
    try {
      const redirect = "&redirect_to=https%3A%2F%2Fbiomie.exemplo.com.br%2Freset-password";
      expect(repo.publicAccessLink(lost + redirect)).toBe(
        `${publicApi}/auth/v1/verify?token=t1&type=invite${redirect}`,
      );
      expect(repo.publicAccessLink(`${publicApi}/auth/v1/verify?token=t2&type=recovery`)).toBe(
        `${publicApi}/auth/v1/verify?token=t2&type=recovery`,
      );
      expect(repo.publicAccessLink("https://link/único")).toBe("https://link/único");
    } finally {
      delete process.env["PUBLIC_SUPABASE_URL"];
    }
  });

  it("convite e novo link saem com o endereço público", async () => {
    process.env["PUBLIC_SUPABASE_URL"] = publicApi;
    try {
      admin.generateLink.mockResolvedValue({
        data: { user: { id: "new" }, properties: { action_link: lost } },
        error: null,
      });
      const { db } = fakeDb({
        admin_validate_new_user: () => ({}),
        admin_provision_user: () => ({ data: user({ id: "new", status: "INVITED" }) }),
      });
      const r = await repo.createUser(db, input);
      expect(r.secret.value).toBe(`${publicApi}/auth/v1/verify?token=t1&type=invite`);

      admin.generateLink.mockResolvedValue({
        data: {
          properties: {
            action_link: "https://biomie.exemplo.com.br/auth/v1/verify?token=t3&type=recovery",
          },
        },
        error: null,
      });
      const again = fakeDb({
        admin_check_action: () => ({ data: null }),
        admin_user: () => ({ data: user() }),
        admin_access_issued: () => ({}),
      });
      const secret = await repo.issueAccess(again.db, "u1", "INVITE_LINK");
      expect(secret.value).toBe(`${publicApi}/auth/v1/verify?token=t3&type=recovery`);
    } finally {
      delete process.env["PUBLIC_SUPABASE_URL"];
    }
  });
});
