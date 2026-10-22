/**
 * Administração de usuários (Admin 2.0).
 *
 * As regras de quem pode o quê ficam no banco (esquema admin_internal, migração 0040) e rodam
 * com o token de quem está agindo: a auditoria registra o autor real. O serviço de login (criar
 * conta, link de acesso, senha, bloqueio, exclusão) só é chamado aqui, no servidor, com a chave
 * de serviço; antes, o banco confirma a permissão; depois, registra o que foi feito.
 * Nunca registre em log senha, link, token ou e-mail.
 */
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  AccessDelivery,
  AccessPatch,
  AccessSecret,
  AdminUser,
  AuditEvent,
  AuditFilter,
  Company,
  CreateUserInput,
  Holiday,
  Me,
  Seller,
  Session,
  Team,
  UserFilter,
} from "@/admin/api/contract";
import { describeDevice } from "@/admin/lib/device";
import { createLoginLimiter } from "../login-limiter.server";
import { signInWithLegacyIdentifier } from "./auth.repository.server";

type Db = SupabaseClient<Database>;
type DbError = { message: string; code?: string };
type AuthError = {
  message?: string | undefined;
  status?: number | undefined;
  code?: string | undefined;
} | null;

/** O serviço de login expira links de convite e recuperação em 24 h (GOTRUE_MAILER_OTP_EXP padrão). */
const LINK_TTL_MS = 24 * 3600_000;
/** Prazo para trocar a senha temporária; depois disso o BIOMIE recusa o primeiro acesso. */
const TEMP_PASSWORD_TTL_MS = 72 * 3600_000;
const BAN_FOREVER = "876000h";
const passwordAttempts = createLoginLimiter(5, 15 * 60_000);

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Mensagens das funções do banco já são escritas para a tela; o resto vira mensagem genérica. */
export function userFacingError(error: DbError): Error {
  const own =
    ["P0001", "P0002", "42501"].includes(error.code ?? "") &&
    !/^permission denied/i.test(error.message);
  if (!own) console.error(`[admin] falha no banco code=${error.code ?? "?"}`);
  return new Error(own ? error.message : "Não foi possível concluir a operação. Tente novamente.");
}

function loginServiceError(error: AuthError, fallback: string): Error {
  console.error(
    `[admin] falha no serviço de login status=${error?.status ?? "?"} code=${error?.code ?? "?"}`,
  );
  if (error?.code === "email_exists" || error?.code === "user_already_exists")
    return new Error("E-mail já cadastrado.");
  if (error?.code === "weak_password")
    return new Error(
      "Senha fraca: use pelo menos 10 caracteres, misturando letras, números e símbolos.",
    );
  if (error?.code === "same_password")
    return new Error("A nova senha precisa ser diferente da atual.");
  return new Error(fallback);
}

async function rpc<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = db as unknown as {
    rpc: (
      f: string,
      a: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: DbError | null }>;
  };
  const { data, error } = await client.rpc(fn, args);
  if (error) throw userFacingError(error);
  return data as T;
}

function accessRedirect(): string {
  const base = process.env["APP_BASE_URL"];
  if (!base) throw new Error("O endereço do sistema não está configurado no servidor.");
  return `${base.replace(/\/+$/, "")}/reset-password`;
}

const VERIFY_PATH = "auth/v1/verify";

/**
 * Link de acesso sempre sob o endereço público da API (PUBLIC_SUPABASE_URL, ".../supabase").
 * O serviço de login monta o link resolvendo GOTRUE_MAILER_URLPATHS_* contra API_EXTERNAL_URL,
 * e um caminho absoluto ("/auth/v1/verify") troca o caminho inteiro: o "/supabase" some e o
 * link cai num 404 do site (teste de navegador em produção, 22/10/2026). Aqui o link é remontado
 * com o mesmo token, para nunca entregar um endereço quebrado (o compose fica para quando o SMTP
 * for ligado: ver o comentário de GOTRUE_MAILER_URLPATHS_*).
 */
export function publicAccessLink(actionLink: string): string {
  const configured = process.env["PUBLIC_SUPABASE_URL"];
  if (!configured) return actionLink;
  const link = new URL(actionLink);
  if (!link.pathname.endsWith(`/${VERIFY_PATH}`)) return actionLink;
  const base = new URL(`${configured.replace(/\/+$/, "")}/`);
  return new URL(`${VERIFY_PATH}${link.search}${link.hash}`, base).toString();
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#%*?";
const pick = (set: string) => set.charAt(randomInt(set.length));

/** Senha temporária legível (sem 0/O, 1/l/I), com as quatro classes e ~80 bits de entropia. */
export function generateTempPassword(): string {
  const all = UPPER + LOWER + DIGITS;
  const block = (first: string) => first + Array.from({ length: 3 }, () => pick(all)).join("");
  return `${block(pick(UPPER))}-${block(pick(LOWER))}-${block(pick(DIGITS))}${pick(SYMBOLS)}`;
}

export function validateNewPassword(next: string, current?: string) {
  if (next.length < 10) throw new Error("A nova senha precisa ter no mínimo 10 caracteres.");
  if (next.length > 200) throw new Error("A nova senha é longa demais.");
  if (current !== undefined && next === current)
    throw new Error("A nova senha precisa ser diferente da atual.");
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Busca, filtros e paginação sobre a lista que o banco já recortou pelo alcance do ator. */
export function filterUsers(all: AdminUser[], f: UserFilter): { rows: AdminUser[]; total: number } {
  const q = f.search ? fold(f.search.trim()) : "";
  const rows = all.filter(
    (u) =>
      (!q ||
        fold([u.fullName, u.email, u.username ?? "", ...u.legacyUsernames].join(" ")).includes(
          q,
        )) &&
      (!f.role || u.roles.includes(f.role)) &&
      (!f.companyId || u.companyIds.includes(f.companyId)) &&
      (!f.status || u.status === f.status),
  );
  const size = Math.min(Math.max(f.pageSize ?? 25, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length };
}

// ---------------------------------------------------------------- leitura

export const me = (db: Db) => rpc<Me>(db, "admin_me");

export async function listUsers(db: Db, f: UserFilter) {
  return filterUsers(await rpc<AdminUser[]>(db, "admin_users"), f);
}

export const getUser = (db: Db, id: string) => rpc<AdminUser>(db, "admin_user", { p_user: id });
export const listCompanies = (db: Db) => rpc<Company[]>(db, "admin_companies");
export const listSellers = (db: Db, companyId: string) =>
  rpc<Seller[]>(db, "admin_company_sellers", { p_company: companyId });
export const listTeams = (db: Db, companyId: string) =>
  rpc<Team[]>(db, "admin_company_teams", { p_company: companyId });
export const listHolidays = (db: Db, year: number) =>
  rpc<Holiday[]>(db, "admin_holidays", { p_year: year });
export const listAudit = (db: Db, f: AuditFilter) =>
  rpc<{ rows: AuditEvent[]; total: number }>(db, "admin_audit", { p_filter: f });

// ---------------------------------------------------------------- criação e acesso

async function createLoginAccount(
  email: string,
  fullName: string,
  delivery: AccessDelivery,
): Promise<{ userId: string; secret: AccessSecret }> {
  if (delivery === "INVITE_LINK") {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { full_name: fullName }, redirectTo: accessRedirect() },
    });
    const link = data?.properties?.action_link;
    if (error || !data?.user || !link)
      throw loginServiceError(error, "Não foi possível criar a conta no serviço de login.");
    return {
      userId: data.user.id,
      secret: { kind: delivery, value: publicAccessLink(link), expiresAt: inMs(LINK_TTL_MS) },
    };
  }
  const password = generateTempPassword();
  const expiresAt = inMs(TEMP_PASSWORD_TTL_MS);
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { must_change_password: true, temp_password_expires_at: expiresAt },
  });
  if (error || !data.user)
    throw loginServiceError(error, "Não foi possível criar a conta no serviço de login.");
  return { userId: data.user.id, secret: { kind: delivery, value: password, expiresAt } };
}

export async function createUser(
  db: Db,
  input: CreateUserInput,
): Promise<{ user: AdminUser; secret: AccessSecret }> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const payload = {
    fullName,
    email,
    username: input.username?.trim().toLowerCase() || null,
    delivery: input.delivery,
    access: {
      roles: input.roles,
      companyIds: input.companyIds,
      defaultCompanyId: input.defaultCompanyId,
      sellerIds: input.roles.includes("VENDEDOR") ? (input.sellerIds ?? []) : [],
      managedTeamIds: input.roles.includes("GESTOR") ? (input.managedTeamIds ?? []) : [],
      permissions: input.permissions ?? [],
    },
  };
  // Ensaio no banco antes de tocar o serviço de login: nada é criado se a regra recusar.
  await rpc(db, "admin_validate_new_user", { p_payload: payload });
  const issued = await createLoginAccount(email, fullName, input.delivery);
  try {
    const user = await rpc<AdminUser>(db, "admin_provision_user", {
      p_user: issued.userId,
      p_payload: { ...payload, expiresAt: issued.secret.expiresAt },
    });
    return { user, secret: issued.secret };
  } catch (error) {
    // Uma conta sem perfil nem acesso não fica para trás no serviço de login.
    await supabaseAdmin.auth.admin.deleteUser(issued.userId).catch(() => undefined);
    throw error;
  }
}

export const updateProfile = (
  db: Db,
  id: string,
  patch: {
    fullName?: string | undefined;
    username?: string | null | undefined;
    defaultCompanyId?: string | undefined;
  },
) => rpc<AdminUser>(db, "admin_update_profile", { p_user: id, p_patch: patch });

export const updateAccess = (db: Db, id: string, access: AccessPatch) =>
  rpc<AdminUser>(db, "admin_update_access", { p_user: id, p_access: access });

async function requireAction(
  db: Db,
  id: string,
  action: "issue" | "block" | "unblock" | "signout",
) {
  const reason = await rpc<string | null>(db, "admin_check_action", {
    p_user: id,
    p_action: action,
  });
  if (reason) throw new Error(reason);
}

export async function issueAccess(
  db: Db,
  id: string,
  delivery: AccessDelivery,
): Promise<AccessSecret> {
  await requireAction(db, id, "issue");
  const target = await getUser(db, id);
  let secret: AccessSecret;
  if (delivery === "INVITE_LINK") {
    let { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: target.email,
      options: { redirectTo: accessRedirect() },
    });
    if ((error || !data?.properties?.action_link) && !target.lastSignInAt) {
      // Convite ainda não aceito: o serviço de login reemite como convite.
      ({ data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: "invite",
        email: target.email,
        options: { redirectTo: accessRedirect() },
      }));
    }
    const link = data?.properties?.action_link;
    if (error || !link) throw loginServiceError(error, "Não foi possível gerar o link de acesso.");
    secret = { kind: delivery, value: publicAccessLink(link), expiresAt: inMs(LINK_TTL_MS) };
  } else {
    const password = generateTempPassword();
    const expiresAt = inMs(TEMP_PASSWORD_TTL_MS);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password,
      email_confirm: true,
      app_metadata: { must_change_password: true, temp_password_expires_at: expiresAt },
    });
    if (error) throw loginServiceError(error, "Não foi possível gerar a senha temporária.");
    secret = { kind: delivery, value: password, expiresAt };
  }
  await rpc(db, "admin_access_issued", {
    p_user: id,
    p_kind: delivery,
    p_expires: secret.expiresAt,
  });
  return secret;
}

export async function setBlocked(
  db: Db,
  id: string,
  blocked: boolean,
  reason: string,
): Promise<AdminUser> {
  if (reason.trim().length < 3) throw new Error("Informe o motivo.");
  await requireAction(db, id, blocked ? "block" : "unblock");
  const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
    ban_duration: blocked ? BAN_FOREVER : "none",
  });
  if (error)
    throw loginServiceError(
      error,
      blocked ? "Não foi possível bloquear o acesso." : "Não foi possível reativar o acesso.",
    );
  try {
    return await rpc<AdminUser>(db, "admin_block_recorded", {
      p_user: id,
      p_blocked: blocked,
      p_reason: reason,
    });
  } catch (failure) {
    // Sem o registro, desfaz no serviço de login para não deixar estado sem auditoria.
    await supabaseAdmin.auth.admin
      .updateUserById(id, { ban_duration: blocked ? "none" : BAN_FOREVER })
      .catch(() => undefined);
    throw failure;
  }
}

export async function signOutEverywhere(db: Db, id: string): Promise<void> {
  await rpc<number>(db, "admin_revoke_sessions", { p_user: id });
}

export async function deleteUser(db: Db, id: string, confirmEmail: string): Promise<void> {
  // Primeiro o banco retira todo o acesso e audita; depois a conta sai do serviço de login
  // (exclusão lógica: a senha some e o e-mail fica livre para um novo cadastro).
  await rpc(db, "admin_delete_user", { p_user: id, p_confirm_email: confirmEmail });
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id, true);
  if (error)
    throw loginServiceError(
      error,
      "O acesso foi retirado, mas a conta não saiu do serviço de login. Tente excluir de novo.",
    );
}

// ---------------------------------------------------------------- empresas e calendário

export const renameCompany = (db: Db, id: string, name: string) =>
  rpc<Company>(db, "admin_rename_company", { p_company: id, p_name: name });
export const saveHoliday = (db: Db, holiday: Omit<Holiday, "id"> & { id?: string | undefined }) =>
  rpc<Holiday>(db, "admin_save_holiday", { p_holiday: holiday });
export async function deleteHoliday(db: Db, id: string): Promise<void> {
  await rpc(db, "admin_delete_holiday", { p_id: id });
}
export const importHolidays = (db: Db, rows: Omit<Holiday, "id">[]) =>
  rpc<{ created: number; duplicates: number }>(db, "admin_import_holidays", { p_rows: rows });

// ---------------------------------------------------------------- minha conta

export const updateMyName = (db: Db, fullName: string) =>
  rpc<Me>(db, "my_update_name", { p_name: fullName });

export async function listMySessions(db: Db): Promise<Session[]> {
  const rows = await rpc<
    { id: string; userAgent: string; ip: string; lastActiveAt: string; current: boolean }[]
  >(db, "my_sessions");
  return rows.map((s) => ({
    id: s.id,
    device: describeDevice(s.userAgent),
    ip: s.ip,
    lastActiveAt: s.lastActiveAt,
    current: s.current,
  }));
}

export async function signOutOtherSessions(db: Db): Promise<void> {
  await rpc<number>(db, "my_revoke_other_sessions");
}

/** Confere a senha atual pelo mesmo caminho do login e encerra a sessão aberta só para isso. */
async function verifyCurrentPassword(email: string, password: string) {
  const tokens = await signInWithLegacyIdentifier({ identifier: email, password }).catch(
    () => null,
  );
  if (!tokens) throw new Error("Senha atual incorreta.");
  await supabaseAdmin.auth.admin.signOut(tokens.access_token, "local").catch(() => undefined);
}

export async function changeMyPassword(
  db: Db,
  user: { id: string; email: string },
  current: string,
  next: string,
): Promise<void> {
  if (!passwordAttempts(`password:${user.id}`))
    throw new Error("Muitas tentativas. Aguarde alguns minutos e tente de novo.");
  validateNewPassword(next, current);
  await verifyCurrentPassword(user.email, current);
  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    password: next,
    app_metadata: { must_change_password: null, temp_password_expires_at: null },
  });
  if (error) throw loginServiceError(error, "Não foi possível alterar a senha.");
  await rpc(db, "my_password_changed", { p_origin: "my_account" });
  // Senha nova derruba os outros dispositivos; este continua conectado.
  await rpc<number>(db, "my_revoke_other_sessions");
}

/** Primeiro acesso com senha temporária: define a senha definitiva e libera o sistema. */
export async function completeFirstPassword(db: Db, userId: string, next: string): Promise<void> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data.user) throw loginServiceError(error, "Não foi possível carregar sua conta.");
  const meta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  if (!meta["must_change_password"]) throw new Error("Sua senha já foi definida.");
  const expiresAt = meta["temp_password_expires_at"];
  if (typeof expiresAt === "string" && Date.parse(expiresAt) < Date.now())
    throw new Error("A senha temporária expirou. Peça um novo acesso ao administrador.");
  validateNewPassword(next);
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: next,
    app_metadata: { must_change_password: null, temp_password_expires_at: null },
  });
  if (updateError) throw loginServiceError(updateError, "Não foi possível definir a senha.");
  await rpc(db, "my_password_changed", { p_origin: "first_access" });
}
