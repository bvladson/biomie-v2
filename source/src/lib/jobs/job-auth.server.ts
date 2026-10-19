import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/** Accepts the managed cron bearer or the database scheduler token (private.job_secrets). */
export async function authorizeJobRequest(request: Request): Promise<Response | null> {
  const denied = await authenticateCronRequest(request);
  if (!denied) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const token = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const { data: ok } = token
    ? await supabaseAdmin.rpc("verify_job_token", { p_token: token })
    : { data: false };
  return ok ? null : new Response("Unauthorized", { status: 401 });
}
