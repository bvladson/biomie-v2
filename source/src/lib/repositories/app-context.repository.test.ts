import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { describe, expect, it, vi } from "vitest";
import { loadAppContext } from "./app-context.repository.server";

const userId = "00000000-0000-4000-8000-000000000001";
const companyId = "00000000-0000-4000-8000-000000000002";
const profile = {
  id: userId,
  email: "unit@example.test",
  full_name: "Unit",
  default_company_id: companyId,
};
const company = { id: companyId, name: "Empresa de teste", is_demo: true };
type Result = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });
const failed = (): Result => ({ data: null, error: { message: "Database unavailable" } });

function mockClient(
  options: {
    profiles?: Result[];
    roles?: Result;
    companies?: Result;
    provision?: Result;
    reference?: Result;
  } = {},
) {
  const profiles = [...(options.profiles ?? [ok(profile)])];
  const rpc = vi.fn(async (name: string) =>
    name === "ensure_app_profile"
      ? (options.provision ?? ok(null))
      : (options.reference ?? ok("2026-10-19")),
  );
  const from = vi.fn((table: string) => ({
    select: vi.fn(() => ({
      eq: vi.fn(() =>
        table === "profiles"
          ? { maybeSingle: vi.fn(async () => profiles.shift() ?? ok(null)) }
          : Promise.resolve(options.roles ?? ok([{ role: "VIEWER" }])),
      ),
      order: vi.fn(async () => options.companies ?? ok([company])),
    })),
  }));
  return { client: { from, rpc } as unknown as SupabaseClient<Database>, from, rpc };
}

describe("Application profile provisioning", () => {
  it("provisions only through the authenticated atomic RPC and reloads the profile", async () => {
    const { client, rpc, from } = mockClient({ profiles: [ok(null), ok(profile)] });
    const context = await loadAppContext(client, userId);
    expect(context.roles).toEqual(["VIEWER"]);
    expect(context.companies[0]?.dataAsOf).toBe("2026-10-19");
    expect(rpc).toHaveBeenCalledWith("ensure_app_profile");
    expect(from.mock.calls.filter(([table]) => table === "profiles")).toHaveLength(2);
  });

  it("preserves existing roles without provisioning or counting administrators", async () => {
    const { client, rpc } = mockClient({ roles: ok([{ role: "SUPER_ADMIN" }]) });
    expect((await loadAppContext(client, userId)).roles).toEqual(["SUPER_ADMIN"]);
    expect(rpc).not.toHaveBeenCalledWith("ensure_app_profile");
  });

  it("does not mistake a profile read failure for a new account", async () => {
    const { client, rpc } = mockClient({ profiles: [failed()] });
    await expect(loadAppContext(client, userId)).rejects.toThrow("carregar seu perfil");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed if provisioning fails", async () => {
    const { client } = mockClient({ profiles: [ok(null)], provision: failed() });
    await expect(loadAppContext(client, userId)).rejects.toThrow("provisionar sua conta");
  });

  it("does not return a context when permissions cannot be loaded", async () => {
    const { client } = mockClient({ roles: failed() });
    await expect(loadAppContext(client, userId)).rejects.toThrow("permissões e empresas");
  });

  it("does not substitute today's browser date when the company reference fails", async () => {
    const { client } = mockClient({ reference: failed() });
    await expect(loadAppContext(client, userId)).rejects.toThrow("data de referência");
  });
});
