import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { httpJobsDisabled } from "@/lib/jobs/job-auth.server";

/** Daily scheduled call (pg_cron). Requires the cron bearer secret. */
export const Route = createFileRoute("/api/public/jobs/flight-plan-snapshots")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Production runs the daily snapshot inside the worker process.
        if (httpJobsDisabled()) return new Response("Not Found", { status: 404 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const denied = await authenticateCronRequest(request);
        if (denied) {
          // Database scheduler (pg_cron) authenticates with its own stored token.
          const token = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
          const { data: ok } = token
            ? await supabaseAdmin.rpc("verify_job_token", { p_token: token })
            : { data: false };
          if (!ok) return new Response("Unauthorized", { status: 401 });
        }
        let date: string | undefined;
        try {
          const body = (await request.json().catch(() => ({}))) as { date?: unknown };
          if (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date))
            date = body.date;
        } catch {
          /* empty body is fine */
        }
        const { runSnapshotJob } = await import("@/lib/jobs/flight-plan-snapshots.server");
        try {
          const result = await runSnapshotJob(supabaseAdmin, {
            ...(date ? { date } : {}),
            trigger: "cron",
          });
          return Response.json(
            { runId: result.runId, status: result.status, rows: result.rows },
            { status: result.status === "success" ? 200 : 500 },
          );
        } catch (e) {
          console.error("snapshot job crashed", e);
          return Response.json({ status: "failed" }, { status: 500 });
        }
      },
    },
  },
});
