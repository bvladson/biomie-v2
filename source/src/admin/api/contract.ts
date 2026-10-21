/** Valor JSON (o que o servidor consegue serializar para a tela). */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AppRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "DIRETORIA"
  | "GESTOR"
  | "VENDEDOR"
  | "FINANCEIRO"
  | "ANALISTA"
  | "VIEWER";
export type GrantablePermission =
  | "documents:view_full" // CPF/CNPJ completo
  | "finance.view_summary" // Resumo financeiro
  | "finance.view_titles" // Títulos
  | "finance.view_customer_details" // Financeiro do cliente
  | "finance.view_overdue" // Inadimplência
  | "finance.export"; // Exportar financeiro
export type UserStatus = "ACTIVE" | "BLOCKED" | "INVITED" | "NEVER_SIGNED_IN";
export type AccessDelivery = "INVITE_LINK" | "TEMP_PASSWORD";

export interface Company {
  id: string;
  slug: string;
  name: string;
  dataSource: "DEMO" | "OMIE_SHADOW" | "OMIE";
  userCount: number;
}
export interface Seller {
  id: string;
  companyId: string;
  name: string;
  active: boolean;
  userId: string | null;
}
export interface Team {
  id: string;
  companyId: string;
  name: string;
  active: boolean;
  managerUserIds: string[];
}
export interface AdminUser {
  id: string;
  fullName: string;
  email: string;
  username: string | null;
  roles: AppRole[];
  companyIds: string[];
  defaultCompanyId: string | null;
  sellerIds: string[]; // um vendedor do Omie por empresa, quando o papel é Vendedor
  managedTeamIds: string[]; // equipes que gerencia, quando o papel é Gestor
  permissions: GrantablePermission[];
  status: UserStatus;
  createdAt: string;
  lastSignInAt: string | null;
  blockedReason: string | null;
  /** Empresas do usuário fora do alcance de quem está vendo: aparecem só como contagem. */
  otherCompanyCount: number;
  /** Apelidos herdados do sistema antigo; continuam valendo no login e não são editados aqui. */
  legacyUsernames: string[];
}
/** Alteração de acesso aplicada de uma vez no servidor (tudo ou nada). Chave ausente = sem mudança. */
export interface AccessPatch {
  roles?: AppRole[] | undefined;
  companyIds?: string[] | undefined;
  defaultCompanyId?: string | null | undefined;
  sellerIds?: string[] | undefined;
  managedTeamIds?: string[] | undefined;
  permissions?: GrantablePermission[] | undefined;
}
export interface UserFilter {
  search?: string | undefined;
  role?: AppRole | undefined;
  companyId?: string | undefined;
  status?: UserStatus | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}
export interface CreateUserInput {
  fullName: string;
  email: string;
  username?: string | undefined;
  roles: AppRole[];
  companyIds: string[];
  defaultCompanyId: string;
  sellerIds?: string[] | undefined;
  managedTeamIds?: string[] | undefined;
  permissions?: GrantablePermission[] | undefined;
  delivery: AccessDelivery;
}
export interface AccessSecret {
  kind: AccessDelivery;
  value: string;
  expiresAt: string;
} // mostrado uma única vez
export interface AuditEvent {
  id: number;
  at: string;
  actorId: string | null;
  actorName: string;
  action: string;
  entity: string;
  entityId: string | null;
  companyId: string | null;
  /** Nome de quem foi alvo, quando o alvo é um usuário. */
  targetName?: string | undefined;
  before?: Record<string, JsonValue> | undefined;
  after?: Record<string, JsonValue> | undefined;
}
export const AUDIT_PAGE_SIZE = 20;
export interface AuditFilter {
  from?: string | undefined;
  to?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  entity?: string | undefined;
  targetId?: string | undefined;
  companyId?: string | undefined;
  page?: number | undefined;
}
export interface Holiday {
  id: string;
  date: string;
  name: string;
  scope: "national" | "state" | "city" | "company";
  companyId: string | null;
}
export interface Session {
  id: string;
  device: string;
  ip: string;
  lastActiveAt: string;
  current: boolean;
}
export interface Me {
  userId: string;
  fullName: string;
  roles: AppRole[];
  companyIds: string[];
}

export interface AdminApi {
  me(): Promise<Me>;
  listUsers(filter: UserFilter): Promise<{ rows: AdminUser[]; total: number }>;
  getUser(id: string): Promise<AdminUser>;
  createUser(input: CreateUserInput): Promise<{ user: AdminUser; secret: AccessSecret }>;
  updateProfile(
    id: string,
    patch: {
      fullName?: string | undefined;
      username?: string | null | undefined;
      defaultCompanyId?: string | undefined;
    },
  ): Promise<AdminUser>;
  updateAccess(id: string, access: AccessPatch): Promise<AdminUser>;
  setRoles(id: string, roles: AppRole[]): Promise<AdminUser>;
  setCompanies(id: string, companyIds: string[]): Promise<AdminUser>;
  setSellers(id: string, sellerIds: string[]): Promise<AdminUser>;
  setManagedTeams(id: string, teamIds: string[]): Promise<AdminUser>;
  setPermissions(id: string, permissions: GrantablePermission[]): Promise<AdminUser>;
  issueAccess(id: string, delivery: AccessDelivery): Promise<AccessSecret>;
  setBlocked(id: string, blocked: boolean, reason: string): Promise<AdminUser>;
  signOutEverywhere(id: string): Promise<void>;
  deleteUser(id: string, confirmEmail: string): Promise<void>;
  listCompanies(): Promise<Company[]>;
  renameCompany(id: string, name: string): Promise<Company>;
  listSellers(companyId: string): Promise<Seller[]>;
  listTeams(companyId: string): Promise<Team[]>;
  listHolidays(year: number): Promise<Holiday[]>;
  saveHoliday(holiday: Omit<Holiday, "id"> & { id?: string | undefined }): Promise<Holiday>;
  deleteHoliday(id: string): Promise<void>;
  importHolidays(rows: Omit<Holiday, "id">[]): Promise<{ created: number; duplicates: number }>;
  listAudit(filter: AuditFilter): Promise<{ rows: AuditEvent[]; total: number }>;
  updateMyName(fullName: string): Promise<Me>;
  changeMyPassword(current: string, next: string): Promise<void>;
  listMySessions(): Promise<Session[]>;
  signOutOtherSessions(): Promise<void>;
}
