import { createFileRoute } from "@tanstack/react-router";
import { authorizeJobRequest } from "@/lib/jobs/job-auth.server";

/** Worker tick: advances one Omie backfill step (time-boxed). Called by the scheduler. */
export const Route = createFileRoute("/api/public/jobs/omie-backfill")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authorizeJobRequest(request);
        if (denied) return denied;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runBackfillTick } = await import("@/lib/omie/sync-tx.server");
        try {
          const r = await runBackfillTick(supabaseAdmin);
          return Response.json({
            jobId: r.jobId,
            status: r.result?.status ?? "IDLE",
            done: r.result?.done ?? true,
          });
        } catch (e) {
          console.error("omie backfill tick crashed", e instanceof Error ? e.message : "unknown");
          return Response.json({ status: "FAILED" }, { status: 500 });
        }
      },
    },
  },
});
