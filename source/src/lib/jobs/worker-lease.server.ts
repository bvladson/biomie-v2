import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** Database leases also exclude another web process, pg_cron or a manual request. */
export async function acquireWorkerLease(
  admin: SupabaseClient<Database>,
  key: string,
  ttlSeconds = 900,
): Promise<(() => Promise<void>) | null> {
  const owner = randomUUID();
  // New operational RPCs are added by migration 0016; generated types lag behind it.
  const db = admin as unknown as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{
      data: unknown;
      error: { message: string } | null;
    }>;
  };
  const { data, error } = await db.rpc("acquire_omie_worker_lease", {
    p_key: key,
    p_owner: owner,
    p_ttl_seconds: ttlSeconds,
  });
  if (error)
    throw new Error(
      "Não foi possível adquirir o lock do worker. Verifique as migrações operacionais.",
    );
  if (data !== true) return null;
  return async () => {
    const { error: releaseError } = await db.rpc("release_omie_worker_lease", {
      p_key: key,
      p_owner: owner,
    });
    if (releaseError) console.error("Worker lease release failed; expiration will recover it.");
  };
}
