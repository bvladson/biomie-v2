import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { canOpenAdmin } from "../lib/rules";
import { ErrorState, Loading, useMe } from "./shared";

const LINKS = [
  { to: "/admin/usuarios", label: "Usuários" },
  { to: "/admin/empresas", label: "Empresas e calendário" },
  { to: "/admin/auditoria", label: "Auditoria" },
  { to: "/admin", label: "Configurações do BI" },
] as const;

/** Navegação entre as áreas da Administração (as páginas novas e as abas que já existiam). */
export function AdminNav() {
  return (
    <nav aria-label="Áreas da administração" className="-mx-1 overflow-x-auto px-1">
      <ul className="flex w-max gap-1 rounded-lg border bg-card p-1 text-sm">
        {LINKS.map((l) => (
          <li key={l.to}>
            <Link
              to={l.to}
              activeOptions={{ exact: l.to === "/admin", includeSearch: false }}
              className="inline-flex whitespace-nowrap rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              activeProps={{ className: "bg-accent font-medium text-accent-foreground" }}
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Moldura das páginas do Admin 2.0: navegação e bloqueio para quem não é administrador. */
export function AdminSection({ children }: { children: ReactNode }) {
  const me = useMe();
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-4 py-6 md:px-6 md:py-8">
      <AdminNav />
      {me.isLoading ? (
        <Loading rows={5} />
      ) : me.error ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : !me.data || !canOpenAdmin(me.data) ? (
        <div
          role="alert"
          className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-lg border bg-card p-8 text-center"
        >
          <Lock className="size-6 text-muted-foreground" aria-hidden />
          <p className="font-medium">Acesso restrito a administradores.</p>
          <Link to="/minha-conta" className="text-sm text-primary underline">
            Ir para Minha conta
          </Link>
        </div>
      ) : (
        children
      )}
    </main>
  );
}

/** Moldura de Minha conta: aberta para qualquer usuário. */
export function AccountSection({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-4 py-6 md:px-6 md:py-8">
      {children}
    </main>
  );
}
