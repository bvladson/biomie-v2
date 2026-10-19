import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadAppContext } from "./repositories/app-context.repository.server";

export type { AppContextDTO } from "./repositories/app-context.repository.server";

/** Profile provisioning is atomic in SQL and never grants an administrator role. */
export const getAppContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => loadAppContext(context.supabase, context.userId));
