import { createServerFn } from "@tanstack/react-start";
import { getRequest, getRequestIP, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";

const loginError = "Não foi possível entrar. Confira seu usuário ou e-mail e sua senha.";
const credentials = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(4096),
});

/** Public password login. Authentication itself remains exclusively in Supabase Auth. */
export const signInWithIdentifier = createServerFn({ method: "POST" })
  .inputValidator((input) => {
    const parsed = credentials.safeParse(input);
    if (!parsed.success) throw new Error(loginError);
    return parsed.data;
  })
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "no-store");
    const { canAttemptLogin } = await import("./login-limiter.server");
    // The reverse proxy overwrites X-Real-IP, and the Node port is private.
    const address = getRequest().headers.get("x-real-ip") ?? getRequestIP() ?? "unknown";
    if (!canAttemptLogin(address.slice(0, 128))) throw new Error(loginError);
    const { signInWithLegacyIdentifier } = await import("./repositories/auth.repository.server");
    return signInWithLegacyIdentifier(data);
  });
