export const ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "DIRETORIA",
  "GESTOR",
  "VENDEDOR",
  "FINANCEIRO",
  "ANALISTA",
  "VIEWER",
] as const;
export type AppRole = (typeof ROLES)[number];

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

export type Permission =
  | "cockpit:view"
  | "finance:view"
  | "explore:use"
  | "admin:manage"
  | "integrations:manage"
  | "flightplan:write"
  /** Edit monthly targets (admins: whole company; managers: own teams, enforced in the database). */
  | "targets:manage";

const MATRIX: Record<AppRole, Permission[]> = {
  SUPER_ADMIN: [
    "cockpit:view",
    "finance:view",
    "explore:use",
    "admin:manage",
    "integrations:manage",
    "flightplan:write",
    "targets:manage",
  ],
  ADMIN: [
    "cockpit:view",
    "finance:view",
    "explore:use",
    "admin:manage",
    "integrations:manage",
    "flightplan:write",
    "targets:manage",
  ],
  DIRETORIA: ["cockpit:view", "finance:view", "explore:use", "flightplan:write"],
  GESTOR: ["cockpit:view", "explore:use", "flightplan:write", "targets:manage"],
  VENDEDOR: ["cockpit:view", "flightplan:write"],
  FINANCEIRO: ["cockpit:view", "finance:view"],
  ANALISTA: ["cockpit:view", "explore:use"],
  VIEWER: ["cockpit:view"],
};

/** UI hint only — data access is enforced by database policies. */
export function hasPermission(roles: AppRole[], p: Permission): boolean {
  return roles.some((r) => MATRIX[r]?.includes(p));
}
