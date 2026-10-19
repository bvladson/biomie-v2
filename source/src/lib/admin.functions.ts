import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ROLES } from "@/domain/rbac";
import { GRANTABLE_PERMISSIONS } from "@/domain/finance";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

async function assertAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data } = await supabase.rpc("is_admin", { _user_id: userId });
  if (!data) throw new Error("Acesso restrito a administradores.");
}

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      context.supabase.from("profiles").select("id,email,full_name,created_at").order("created_at"),
      context.supabase.from("user_roles").select("user_id,role"),
    ]);
    const { data: perms } = await context.supabase
      .from("user_permissions")
      .select("user_id,permission");
    return (profiles ?? []).map((p) => ({
      id: p.id,
      email: p.email,
      fullName: p.full_name,
      roles: (roles ?? []).filter((r) => r.user_id === p.id).map((r) => r.role),
      permissions: (perms ?? []).filter((r) => r.user_id === p.id).map((r) => r.permission),
    }));
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ userId: z.string().uuid(), role: z.enum(ROLES), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    // RLS enforces: only admins, only SUPER_ADMIN grants SUPER_ADMIN, no self-revoke.
    const q = data.enabled
      ? context.supabase.from("user_roles").insert({ user_id: data.userId, role: data.role })
      : context.supabase
          .from("user_roles")
          .delete()
          .eq("user_id", data.userId)
          .eq("role", data.role);
    const { error } = await q;
    if (error) throw new Error("Operação não permitida.");
    return { ok: true };
  });

// ---------- Flight Plan settings ----------

/** Explicit extra permission (finance capabilities, full document). Audited. */
export const setUserPermission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        userId: z.string().uuid(),
        permission: z.enum(GRANTABLE_PERMISSIONS),
        enabled: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = data.enabled
      ? await supabaseAdmin
          .from("user_permissions")
          .upsert(
            { user_id: data.userId, permission: data.permission, granted_by: context.userId },
            { onConflict: "user_id,permission" },
          )
      : await supabaseAdmin
          .from("user_permissions")
          .delete()
          .eq("user_id", data.userId)
          .eq("permission", data.permission);
    if (error) throw new Error("Não foi possível atualizar a permissão.");
    await supabaseAdmin.from("audit_log").insert({
      actor_id: context.userId,
      action: data.enabled ? "permission.grant" : "permission.revoke",
      entity: "user_permissions",
      entity_id: data.userId,
      payload: { permission: data.permission },
    });
    return { ok: true };
  });

export const getFlightPlanSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { resolveConfig } = await import("@/domain/flight-plan/config");
    const { data } = await context.supabase
      .from("metric_config")
      .select("config, version, updated_at")
      .eq("metric_key", "flight_plan")
      .maybeSingle();
    return {
      config: resolveConfig(data?.config),
      version: data?.version ?? 1,
      updatedAt: data?.updated_at ?? null,
    };
  });

export const setActiveTargetLevel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ level: z.enum(["BASE", "ACTIVE", "CHALLENGE"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("metric_config")
      .select("config, version")
      .eq("metric_key", "flight_plan")
      .maybeSingle();
    const before = (row?.config ?? {}) as Record<string, unknown>;
    const next = { ...before, activeLevel: data.level };
    const { error } = await supabaseAdmin.from("metric_config").upsert({
      metric_key: "flight_plan",
      config: next,
      version: (row?.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error("Não foi possível salvar a configuração.");
    await supabaseAdmin.from("audit_log").insert({
      actor_id: context.userId,
      action: "update",
      entity: "metric_config.flight_plan",
      entity_id: "activeLevel",
      payload: { from: String(before["activeLevel"] ?? "ACTIVE"), to: data.level },
    });
    return { ok: true };
  });

// ---------- Audit ----------

export const listAuditLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data } = await context.supabase
      .from("audit_log")
      .select("id, actor_id, action, entity, entity_id, payload, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    const ids = [...new Set((data ?? []).map((r) => r.actor_id).filter(Boolean))] as string[];
    const { data: people } = ids.length
      ? await context.supabase.from("profiles").select("id, email, full_name").in("id", ids)
      : { data: [] };
    const who = new Map((people ?? []).map((p) => [p.id, p.full_name || p.email || p.id]));
    return (data ?? []).map((r) => ({
      ...r,
      payload: JSON.stringify(r.payload ?? {}),
      actor: r.actor_id ? (who.get(r.actor_id) ?? "—") : "Sistema",
    }));
  });

// ---------- Jobs ----------

export const listJobRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data } = await context.supabase
      .from("job_runs")
      .select("id, job_name, status, trigger, started_at, finished_at, rows_written, error")
      .order("started_at", { ascending: false })
      .limit(30);
    return data ?? [];
  });

export const reprocessSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        company: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: canAccess } = await context.supabase.rpc("can_access_company", {
      _user_id: context.userId,
      _company: data.company,
    });
    if (!canAccess) throw new Error("Sem acesso a esta empresa.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runSnapshotJob } = await import("@/lib/jobs/flight-plan-snapshots.server");
    const res = await runSnapshotJob(supabaseAdmin, {
      companyIds: [data.company],
      date: data.date,
      trigger: "manual",
      triggeredBy: context.userId,
    });
    await supabaseAdmin.from("audit_log").insert({
      actor_id: context.userId,
      action: "reprocess",
      entity: "flight_plan_snapshots",
      entity_id: data.company,
      payload: { date: data.date, runId: res.runId, rows: res.rows, status: res.status },
    });
    if (res.status === "failed")
      throw new Error(res.companies[0]?.error ?? "Falha no reprocessamento.");
    return { rows: res.rows, runId: res.runId };
  });

// ---------- Sales teams ----------

export const listTeams = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ company: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const sb = context.supabase;
    const [teams, members, managers, sellers, users] = await Promise.all([
      sb.from("sales_teams").select("id,name,active").eq("company_id", data.company).order("name"),
      sb.from("sales_team_members").select("id,team_id,seller_id,valid_from,valid_to"),
      sb.from("sales_team_managers").select("id,team_id,user_id,valid_from,valid_to"),
      sb.from("sellers").select("id,name,active").eq("company_id", data.company).order("name"),
      sb.from("profiles").select("id,email,full_name"),
    ]);
    const ids = new Set((teams.data ?? []).map((t) => t.id));
    return {
      teams: (teams.data ?? []).map((t) => ({
        ...t,
        members: (members.data ?? []).filter((m) => m.team_id === t.id && !m.valid_to),
        history: (members.data ?? []).filter((m) => m.team_id === t.id && m.valid_to),
        managers: (managers.data ?? []).filter((m) => m.team_id === t.id && !m.valid_to),
      })),
      sellers: sellers.data ?? [],
      users: (users.data ?? []).map((u) => ({ id: u.id, label: u.full_name ?? u.email ?? u.id })),
      teamIds: [...ids],
    };
  });

const teamAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    company: z.string().uuid(),
    name: z.string().trim().min(2).max(80),
  }),
  z.object({
    type: z.literal("rename"),
    team: z.string().uuid(),
    name: z.string().trim().min(2).max(80),
  }),
  z.object({ type: z.literal("toggle"), team: z.string().uuid(), active: z.boolean() }),
  z.object({ type: z.literal("addMember"), team: z.string().uuid(), seller: z.string().uuid() }),
  z.object({ type: z.literal("removeMember"), team: z.string().uuid(), seller: z.string().uuid() }),
  z.object({ type: z.literal("addManager"), team: z.string().uuid(), user: z.string().uuid() }),
  z.object({ type: z.literal("removeManager"), team: z.string().uuid(), user: z.string().uuid() }),
]);

export type TeamAction = z.infer<typeof teamAction>;

/** Team changes never delete history: memberships/managers are closed with valid_to. */
export const updateTeam = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => teamAction.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const today = new Date().toISOString().slice(0, 10);
    // Verify the caller can access the team's company.
    let company: string;
    if (data.type === "create") company = data.company;
    else {
      const { data: t } = await db
        .from("sales_teams")
        .select("company_id")
        .eq("id", data.team)
        .single();
      if (!t) throw new Error("Equipe não encontrada.");
      company = t.company_id;
    }
    const { data: ok } = await context.supabase.rpc("can_access_company", {
      _user_id: context.userId,
      _company: company,
    });
    if (!ok) throw new Error("Sem acesso a esta empresa.");
    let error: { message: string } | null = null;
    let entityId = data.type === "create" ? "" : data.team;
    switch (data.type) {
      case "create": {
        const r = await db
          .from("sales_teams")
          .insert({ company_id: data.company, name: data.name })
          .select("id")
          .single();
        error = r.error;
        entityId = r.data?.id ?? "";
        break;
      }
      case "rename":
        ({ error } = await db.from("sales_teams").update({ name: data.name }).eq("id", data.team));
        break;
      case "toggle":
        ({ error } = await db
          .from("sales_teams")
          .update({ active: data.active })
          .eq("id", data.team));
        break;
      case "addMember": {
        const { data: s } = await db
          .from("sellers")
          .select("company_id")
          .eq("id", data.seller)
          .single();
        if (s?.company_id !== company) throw new Error("Vendedor de outra empresa.");
        // Close any open membership (seller moves teams; history is preserved).
        await db
          .from("sales_team_members")
          .update({ valid_to: today })
          .eq("seller_id", data.seller)
          .is("valid_to", null);
        ({ error } = await db
          .from("sales_team_members")
          .insert({ team_id: data.team, seller_id: data.seller, valid_from: today }));
        break;
      }
      case "removeMember":
        ({ error } = await db
          .from("sales_team_members")
          .update({ valid_to: today })
          .eq("team_id", data.team)
          .eq("seller_id", data.seller)
          .is("valid_to", null));
        break;
      case "addManager":
        ({ error } = await db
          .from("sales_team_managers")
          .insert({ team_id: data.team, user_id: data.user, valid_from: today }));
        break;
      case "removeManager":
        ({ error } = await db
          .from("sales_team_managers")
          .update({ valid_to: today })
          .eq("team_id", data.team)
          .eq("user_id", data.user)
          .is("valid_to", null));
        break;
    }
    if (error)
      throw new Error(
        error.message.includes("duplicate")
          ? "Já existe com esse nome/vínculo."
          : "Não foi possível salvar.",
      );
    await db.from("audit_log").insert({
      actor_id: context.userId,
      action: data.type,
      entity: "sales_teams",
      entity_id: entityId,
      payload: data,
    });
    return { ok: true };
  });
