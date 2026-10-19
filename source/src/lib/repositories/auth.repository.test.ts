import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { describe, expect, it, vi } from "vitest";
import { authenticateIdentifier } from "./auth.repository.server";

const genericError = "Não foi possível entrar. Confira seu usuário ou e-mail e sua senha.";
const tokens = { access_token: "test-access", refresh_token: "test-refresh" };

function clients(alias: string | null, authError: unknown = null, rpcError: unknown = null) {
  const rpc = vi.fn(async () => ({ data: alias, error: rpcError }));
  const signInWithPassword = vi.fn(async () => ({
    data: { session: authError ? null : { ...tokens, user: { email: "private@example.test" } } },
    error: authError,
  }));
  return {
    admin: { rpc } as unknown as SupabaseClient<Database>,
    auth: { auth: { signInWithPassword } } as unknown as SupabaseClient<Database>,
    rpc,
    signInWithPassword,
  };
}

describe("Legacy identifier sign-in", () => {
  it("resolves a private username and returns only Auth tokens", async () => {
    const { admin, auth, rpc, signInWithPassword } = clients("private@example.test");
    const result = await authenticateIdentifier(admin, auth, {
      identifier: " LegacyUser ",
      password: "old",
    });
    expect(rpc).toHaveBeenCalledWith("resolve_legacy_login", { p_identifier: "legacyuser" });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "private@example.test",
      password: "old",
    });
    expect(result).toEqual(tokens);
    expect(Object.keys(result).sort()).toEqual(["access_token", "refresh_token"]);
  });

  it("allows a new Supabase email when there is no legacy alias", async () => {
    const { admin, auth, signInWithPassword } = clients(null);
    await authenticateIdentifier(admin, auth, {
      identifier: "NEW@example.test",
      password: "secret",
    });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "new@example.test",
      password: "secret",
    });
  });

  it("unknown usernames still use Auth and cannot obtain tokens", async () => {
    const { admin, auth, signInWithPassword } = clients(null);
    await expect(
      authenticateIdentifier(admin, auth, { identifier: "unknown", password: "wrong" }),
    ).rejects.toThrow(genericError);
    expect(signInWithPassword).toHaveBeenCalledOnce();
  });

  it("does not reveal password errors or the resolved account address", async () => {
    const { admin, auth } = clients(
      "private@example.test",
      new Error("private@example.test is banned"),
    );
    await expect(
      authenticateIdentifier(admin, auth, { identifier: "legacy", password: "wrong" }),
    ).rejects.toThrow(genericError);
  });

  it("fails closed on alias database errors without attempting password authentication", async () => {
    const { admin, auth, signInWithPassword } = clients(null, null, new Error("database details"));
    await expect(
      authenticateIdentifier(admin, auth, { identifier: "legacy", password: "wrong" }),
    ).rejects.toThrow(genericError);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
