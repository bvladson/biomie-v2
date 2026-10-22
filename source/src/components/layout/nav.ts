import {
  BarChart3,
  Boxes,
  Compass,
  Database,
  Gauge,
  LineChart,
  Map,
  Plane,
  Plug,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  Users,
  UserSquare2,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/domain/rbac";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission?: Permission;
  /** Módulo com liberação gradual: só aparece quando o banco o libera para o usuário. */
  feature?: string;
  ready?: boolean;
}

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Análise",
    items: [
      { to: "/cockpit", label: "Cockpit", icon: Gauge, ready: true },
      { to: "/plano-de-voo", label: "Plano de Voo", icon: Plane, ready: true },
      { to: "/vendas", label: "Vendas", icon: ShoppingCart, ready: true },
      { to: "/vendedores", label: "Vendedores", icon: UserSquare2, ready: true },
      { to: "/clientes", label: "Clientes", icon: Users, ready: true },
      { to: "/produtos", label: "Produtos", icon: Boxes, ready: true },
      { to: "/estoque", label: "Estoque", icon: Warehouse, feature: "stock", ready: true },
      { to: "/financeiro", label: "Financeiro", icon: Wallet, ready: true },
      { to: "/geografia", label: "Geografia", icon: Map },
      { to: "/forecast", label: "Forecast", icon: LineChart },
    ],
  },
  {
    label: "Dados",
    items: [
      { to: "/explorar", label: "Explorar Dados", icon: Compass, permission: "explore:use" },
      { to: "/qualidade-dos-dados", label: "Qualidade dos Dados", icon: ShieldCheck, ready: true },
      {
        to: "/integracoes",
        label: "Integrações",
        icon: Plug,
        permission: "integrations:manage",
        ready: true,
      },
    ],
  },
  {
    label: "Sistema",
    items: [
      {
        to: "/admin",
        label: "Administração",
        icon: Settings2,
        permission: "admin:manage",
        ready: true,
      },
    ],
  },
];

export const ICONS = { BarChart3, Database };
