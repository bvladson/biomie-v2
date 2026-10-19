import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface LoginCredentials {
  identifier: string;
  password: string;
}

const loginError = "Não foi possível entrar. Confira seu usuário ou e-mail e sua senha.";

/** Resolves a private alias, then verifies the password through GoTrue, never locally. */
export async function authenticateIdentifier(
  admin: SupabaseClient<Database>,
  passwordClient: SupabaseClient<Database>,
  input: LoginCredentials,
): Promise<{ access_token: string; refresh_token: string }> {
  try {
    const identifier = input.identifier.trim().toLowerCase();
    const { data: alias, error } = await admin.rpc("resolve_legacy_login", {
      p_identifier: identifier,
    });
    if (error) throw new Error(loginError);
    // Unknown usernames still take the same Auth request path. Its dummy address
    // cannot be registered through a publicly deliverable email domain.
    const email = alias ?? (identifier.includes("@") ? identifier : "invalid-login@biomie.invalid");
    const { data, error: authError } = await passwordClient.auth.signInWithPassword({
      email,
      password: input.password,
    });
    if (
      authError ||
      (!alias && !identifier.includes("@")) ||
      !data.session?.access_token ||
      !data.session.refresh_token
    )
      throw new Error(loginError);
    // No resolved address, user metadata or provider error crosses this boundary.
    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    };
  } catch {
    throw new Error(loginError);
  }
}

export async function signInWithLegacyIdentifier(input: LoginCredentials) {
  try {
    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
    if (!url || !key) throw new Error(loginError);
    // Each attempt gets its own Auth client: a shared client would mix sessions
    // between users signing in at the same time.
    const passwordClient = createClient<Database>(url, key, {
      global: {
        fetch: (request, init) => {
          const headers = new Headers(init?.headers);
          if (key.startsWith("sb_publishable_") && headers.get("authorization") === `Bearer ${key}`)
            headers.delete("authorization");
          return fetch(request, { ...init, headers });
        },
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return await authenticateIdentifier(supabaseAdmin, passwordClient, input);
  } catch {
    throw new Error(loginError);
  }
}
