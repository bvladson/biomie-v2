/**
 * Funções de servidor do Admin 2.0 (usuários, acessos, calendário, auditoria e Minha conta).
 * Toda decisão de permissão é do banco (admin_internal); aqui só se valida o formato da entrada
 * e se delega ao repositório, carregado apenas no servidor.
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const repo = () => import("./repositories/admin-users.repository.server");

const id = z.string().uuid();
const role = z.enum([
  "SUPER_ADMIN",
  "ADMIN",
  "DIRETORIA",
  "GESTOR",
  "VENDEDOR",
  "FINANCEIRO",
  "ANALISTA",
  "VIEWER",
]);
const permission = z.enum([
  "documents:view_full",
  "finance.view_summary",
  "finance.view_titles",
  "finance.view_customer_details",
  "finance.view_overdue",
  "finance.export",
  "stock.view_cost",
  "stock.classify",
  "stock.export",
]);
const status = z.enum(["ACTIVE", "BLOCKED", "INVITED", "NEVER_SIGNED_IN"]);
const delivery = z.enum(["INVITE_LINK", "TEMP_PASSWORD"]);
const ids = z.array(id).max(200);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const access = z
  .object({
    roles: z.array(role).max(8).optional(),
    companyIds: ids.optional(),
    defaultCompanyId: id.nullable().optional(),
    sellerIds: ids.optional(),
    managedTeamIds: ids.optional(),
    permissions: z.array(permission).max(6).optional(),
  })
  .strict();
const holiday = z
  .object({
    id: id.optional(),
    date: isoDate,
    name: z.string().trim().min(1).max(120),
    scope: z.enum(["national", "state", "city", "company"]),
    companyId: id.nullable(),
  })
  .strict();

const noStore = () => setResponseHeader("Cache-Control", "no-store");

// ---------------------------------------------------------------- leitura

export const adminMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await repo()).me(context.supabase));

export const adminListUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        search: z.string().max(200).optional(),
        role: role.optional(),
        companyId: id.optional(),
        status: status.optional(),
        page: z.number().int().min(1).max(10_000).optional(),
        pageSize: z.number().int().min(1).max(500).optional(),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).listUsers(context.supabase, data));

export const adminGetUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id }).parse(i))
  .handler(async ({ data, context }) => (await repo()).getUser(context.supabase, data.id));

export const adminListCompanies = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await repo()).listCompanies(context.supabase));

export const adminListSellers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: id }).parse(i))
  .handler(async ({ data, context }) =>
    (await repo()).listSellers(context.supabase, data.companyId),
  );

export const adminListTeams = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ companyId: id }).parse(i))
  .handler(async ({ data, context }) => (await repo()).listTeams(context.supabase, data.companyId));

export const adminListHolidays = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ year: z.number().int().min(2000).max(2100) }).parse(i))
  .handler(async ({ data, context }) => (await repo()).listHolidays(context.supabase, data.year));

export const adminListAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        actorId: id.optional(),
        action: z.string().max(80).optional(),
        entity: z.string().max(80).optional(),
        targetId: z.string().max(80).optional(),
        companyId: id.optional(),
        page: z.number().int().min(1).max(100_000).optional(),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).listAudit(context.supabase, data));

// ---------------------------------------------------------------- usuários

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        fullName: z.string().trim().min(3).max(120),
        email: z.string().trim().email().max(254),
        username: z.string().trim().max(40).optional(),
        roles: z.array(role).min(1).max(8),
        companyIds: ids.min(1),
        defaultCompanyId: id,
        sellerIds: ids.optional(),
        managedTeamIds: ids.optional(),
        permissions: z.array(permission).max(6).optional(),
        delivery,
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).createUser(context.supabase, data);
  });

export const adminUpdateProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id,
        patch: z
          .object({
            fullName: z.string().trim().min(3).max(120).optional(),
            username: z.string().trim().max(40).nullable().optional(),
            defaultCompanyId: id.optional(),
          })
          .strict(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) =>
    (await repo()).updateProfile(context.supabase, data.id, data.patch),
  );

export const adminUpdateAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id, access }).parse(i))
  .handler(async ({ data, context }) =>
    (await repo()).updateAccess(context.supabase, data.id, data.access),
  );

export const adminIssueAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id, delivery }).parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    return (await repo()).issueAccess(context.supabase, data.id, data.delivery);
  });

export const adminSetBlocked = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ id, blocked: z.boolean(), reason: z.string().trim().min(3).max(500) }).parse(i),
  )
  .handler(async ({ data, context }) =>
    (await repo()).setBlocked(context.supabase, data.id, data.blocked, data.reason),
  );

export const adminSignOutEverywhere = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id }).parse(i))
  .handler(async ({ data, context }) => {
    await (await repo()).signOutEverywhere(context.supabase, data.id);
    return { ok: true };
  });

export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id, confirmEmail: z.string().trim().max(254) }).parse(i))
  .handler(async ({ data, context }) => {
    await (await repo()).deleteUser(context.supabase, data.id, data.confirmEmail);
    return { ok: true };
  });

// ---------------------------------------------------------------- empresas e calendário

export const adminRenameCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id, name: z.string().trim().min(2).max(120) }).parse(i))
  .handler(async ({ data, context }) =>
    (await repo()).renameCompany(context.supabase, data.id, data.name),
  );

export const adminSaveHoliday = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => holiday.parse(i))
  .handler(async ({ data, context }) => (await repo()).saveHoliday(context.supabase, data));

export const adminDeleteHoliday = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id }).parse(i))
  .handler(async ({ data, context }) => {
    await (await repo()).deleteHoliday(context.supabase, data.id);
    return { ok: true };
  });

export const adminImportHolidays = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        rows: z
          .array(holiday.omit({ id: true }))
          .min(1)
          .max(400),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => (await repo()).importHolidays(context.supabase, data.rows));

// ---------------------------------------------------------------- minha conta (qualquer usuário)

export const myUpdateName = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ fullName: z.string().trim().min(3).max(120) }).parse(i))
  .handler(async ({ data, context }) =>
    (await repo()).updateMyName(context.supabase, data.fullName),
  );

export const myChangePassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ current: z.string().min(1).max(4096), next: z.string().min(10).max(200) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    noStore();
    const email = typeof context.claims["email"] === "string" ? context.claims["email"] : "";
    if (!email) throw new Error("Não foi possível identificar sua conta. Entre de novo.");
    await (
      await repo()
    ).changeMyPassword(context.supabase, { id: context.userId, email }, data.current, data.next);
    return { ok: true };
  });

export const myCompleteFirstPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ next: z.string().min(10).max(200) }).parse(i))
  .handler(async ({ data, context }) => {
    noStore();
    await (await repo()).completeFirstPassword(context.supabase, context.userId, data.next);
    return { ok: true };
  });

export const myListSessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await repo()).listMySessions(context.supabase));

export const mySignOutOtherSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await (await repo()).signOutOtherSessions(context.supabase);
    return { ok: true };
  });
