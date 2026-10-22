/**
 * Regras de permissão do módulo Admin (puras). A tela usa para esconder/desabilitar
 * com motivo; o mock usa as mesmas regras para recusar com erro claro.
 * A API real deve aplicar as mesmas regras no servidor.
 */
import type { AdminUser, AppRole, GrantablePermission, Me, UserStatus } from "../api/contract";

export const ROLE_ORDER: AppRole[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "DIRETORIA",
  "GESTOR",
  "VENDEDOR",
  "FINANCEIRO",
  "ANALISTA",
  "VIEWER",
];
export const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: "Super admin",
  ADMIN: "Admin",
  DIRETORIA: "Diretoria",
  GESTOR: "Gestor",
  VENDEDOR: "Vendedor",
  FINANCEIRO: "Financeiro",
  ANALISTA: "Analista",
  VIEWER: "Visualizador",
};
export const ROLE_HELP: Record<AppRole, string> = {
  SUPER_ADMIN: "Tudo, em todas as empresas; é o único que altera papéis e exclui usuários.",
  ADMIN: "Administra os usuários das suas empresas e vê todos os indicadores e o financeiro delas.",
  DIRETORIA: "Todos os indicadores e o financeiro completo das suas empresas.",
  GESTOR:
    "Os números dos vendedores das equipes que gerencia, inclusive o financeiro desses clientes (sem exportar).",
  VENDEDOR: "Só os próprios números e o resumo financeiro; exige vínculo com um vendedor do Omie.",
  FINANCEIRO: "Os indicadores de todos os vendedores e o financeiro completo.",
  ANALISTA: "Os indicadores de todos os vendedores e o resumo financeiro.",
  VIEWER: "Os indicadores de vendas de todos os vendedores das suas empresas, sem o financeiro.",
};
/** Papéis que enxergam todos os vendedores das empresas (espelha public.has_broad_scope). */
export const BROAD_SCOPE_ROLES: AppRole[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "DIRETORIA",
  "FINANCEIRO",
  "ANALISTA",
  "VIEWER",
];
const FINANCE_FULL: GrantablePermission[] = [
  "finance.view_summary",
  "finance.view_titles",
  "finance.view_customer_details",
  "finance.view_overdue",
  "finance.export",
];
/** Capacidades do financeiro por papel e permissões extras (espelha public.finance_capabilities). */
export function financeCapabilitiesFor(
  roles: AppRole[],
  permissions: GrantablePermission[],
): GrantablePermission[] {
  const caps = new Set<GrantablePermission>();
  for (const r of roles) {
    if (r === "SUPER_ADMIN" || r === "ADMIN" || r === "DIRETORIA" || r === "FINANCEIRO")
      FINANCE_FULL.forEach((c) => caps.add(c));
    else if (r === "GESTOR")
      FINANCE_FULL.filter((c) => c !== "finance.export").forEach((c) => caps.add(c));
    else if (r === "ANALISTA" || r === "VENDEDOR") caps.add("finance.view_summary");
  }
  for (const p of permissions) if (p.startsWith("finance.")) caps.add(p);
  return FINANCE_FULL.filter((c) => caps.has(c));
}
export const OPERATIONAL_ROLES: AppRole[] = [
  "DIRETORIA",
  "GESTOR",
  "VENDEDOR",
  "FINANCEIRO",
  "ANALISTA",
  "VIEWER",
];
export const PERMISSION_LABELS: Record<GrantablePermission, string> = {
  "documents:view_full": "CPF/CNPJ completo",
  "finance.view_summary": "Resumo financeiro",
  "finance.view_titles": "Títulos",
  "finance.view_customer_details": "Financeiro do cliente",
  "finance.view_overdue": "Inadimplência",
  "finance.export": "Exportar financeiro",
  "stock.view_cost": "Estoque: ver custo e simular",
  "stock.classify": "Estoque: classificar curvas",
  "stock.export": "Estoque: exportar",
};
export const ALL_PERMISSIONS = Object.keys(PERMISSION_LABELS) as GrantablePermission[];
export const STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: "Ativo",
  BLOCKED: "Bloqueado",
  INVITED: "Convite pendente",
  NEVER_SIGNED_IN: "Nunca entrou",
};

const isSuperRoles = (r: AppRole[]) => r.includes("SUPER_ADMIN");
const isAdminRoles = (r: AppRole[]) => isSuperRoles(r) || r.includes("ADMIN");
type Actor = Pick<Me, "userId" | "roles" | "companyIds">;
type Target = Pick<AdminUser, "id" | "roles" | "companyIds">;

export const canOpenAdmin = (me: Actor) => isAdminRoles(me.roles);

/** Admin só vê usuários com acesso a pelo menos uma das empresas dele. */
export function canSeeUser(me: Actor, t: Target): boolean {
  if (isSuperRoles(me.roles)) return true;
  if (!isAdminRoles(me.roles)) return false;
  return t.companyIds.some((c) => me.companyIds.includes(c)) || t.id === me.userId;
}

/** Motivo pelo qual o ator não pode gerenciar o alvo (null = pode). */
export function manageBlockReason(me: Actor, t: Target): string | null {
  if (isSuperRoles(me.roles)) return null;
  if (!isAdminRoles(me.roles)) return "Acesso restrito a administradores.";
  if (!canSeeUser(me, t)) return "Usuário fora das suas empresas.";
  if (isAdminRoles(t.roles) && t.id !== me.userId)
    return "Admin não altera outro Admin nem Super admin.";
  return null;
}

export function roleChangeBlockReason(me: Actor): string | null {
  return isSuperRoles(me.roles) ? null : "Somente o Super admin altera papéis.";
}

export function rolesGrantableOnCreate(me: Actor): AppRole[] {
  if (isSuperRoles(me.roles)) return ROLE_ORDER;
  if (isAdminRoles(me.roles)) return OPERATIONAL_ROLES;
  return [];
}

export function companiesGrantable(me: Actor, all: string[]): string[] {
  return isSuperRoles(me.roles) ? all : all.filter((c) => me.companyIds.includes(c));
}

export function selfActionReason(me: Actor, t: Target, action: "block" | "delete"): string | null {
  if (me.userId !== t.id) return null;
  return action === "block"
    ? "Você não pode bloquear a si mesmo."
    : "Você não pode excluir a si mesmo.";
}

/** Ninguém remove o próprio acesso de administrador. */
export function removesOwnAdmin(me: Actor, targetId: string, nextRoles: AppRole[]): boolean {
  if (me.userId !== targetId) return false;
  return isAdminRoles(me.roles) && !isAdminRoles(nextRoles);
}

export const USERNAME_RE = /^[a-z0-9.-]{3,40}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function usernameError(v: string): string | null {
  if (!v) return null;
  if (v !== v.toLowerCase()) return "Use apenas letras minúsculas.";
  if (!USERNAME_RE.test(v))
    return "De 3 a 40 caracteres: letras minúsculas, números, ponto ou hífen.";
  return null;
}

/** Valida a combinação de acesso (usado no assistente e no detalhe). */
export function accessErrors(a: {
  roles: AppRole[];
  companyIds: string[];
  defaultCompanyId?: string | null;
  sellerIds: string[];
}): string[] {
  const errs: string[] = [];
  if (!a.roles.length) errs.push("Escolha pelo menos um papel.");
  if (!a.companyIds.length) errs.push("Escolha pelo menos uma empresa.");
  if (a.defaultCompanyId !== undefined && a.companyIds.length && !a.defaultCompanyId)
    errs.push("Escolha a empresa padrão.");
  if (a.defaultCompanyId && !a.companyIds.includes(a.defaultCompanyId))
    errs.push("A empresa padrão precisa ser uma das empresas escolhidas.");
  if (a.roles.includes("VENDEDOR") && !a.sellerIds.length)
    errs.push("Vendedor precisa estar vinculado a um vendedor do Omie.");
  return errs;
}

/** Resumo em linguagem simples do que a combinação permite ver (mesmas regras do banco). */
export function describeVisibility(
  a: { roles: AppRole[]; companyIds: string[]; permissions: GrantablePermission[] },
  companyName: (id: string) => string,
  teamCount = 0,
): string {
  if (!a.roles.length) return "Sem papel: não vê nenhum dado.";
  if (a.roles.includes("SUPER_ADMIN"))
    return "Vê tudo, em todas as empresas, e administra o sistema.";
  const names = a.companyIds.map(companyName);
  const parts: string[] = [];
  parts.push(
    names.length
      ? `Vê ${names.length > 1 ? names.slice(0, -1).join(", ") + " e " + names.at(-1) : names[0]}.`
      : "Nenhuma empresa concedida: não vê dados.",
  );
  const r = a.roles;
  if (r.some((x) => BROAD_SCOPE_ROLES.includes(x)))
    parts.push("Os números de todos os vendedores dessas empresas.");
  else {
    if (r.includes("VENDEDOR")) parts.push("Só os números do próprio vendedor.");
    if (r.includes("GESTOR"))
      parts.push(
        teamCount
          ? `Os números dos vendedores de ${teamCount} equipe${teamCount > 1 ? "s" : ""}.`
          : "Os números das equipes que gerencia (nenhuma escolhida ainda).",
      );
  }
  if (r.includes("ADMIN")) parts.push("Administra os usuários dessas empresas.");
  const fin = financeCapabilitiesFor(r, a.permissions);
  if (!fin.length) parts.push("Não vê o Financeiro.");
  else if (fin.length === FINANCE_FULL.length) parts.push("Vê o Financeiro completo.");
  else parts.push(`Do Financeiro, vê: ${fin.map((c) => PERMISSION_LABELS[c]).join(", ")}.`);
  if (a.permissions.includes("documents:view_full"))
    parts.push("Pode revelar CPF/CNPJ completo (com justificativa registrada).");
  return parts.join(" ");
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "nunca";
  const diff = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} dia${d > 1 ? "s" : ""}`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `há ${mo} ${mo > 1 ? "meses" : "mês"}`;
  return `há ${Math.floor(mo / 12)} ano(s)`;
}

export const whatsappText = (name: string, value: string, expiresAt: string, kind: string) =>
  kind === "INVITE_LINK"
    ? `Olá, ${name}! Seu acesso ao BIOMIE: ${value}. O link vale até ${new Date(expiresAt).toLocaleString("pt-BR")}.`
    : `Olá, ${name}! Sua senha temporária do BIOMIE: ${value}. Troque no primeiro acesso; ela vale até ${new Date(expiresAt).toLocaleString("pt-BR")}.`;
