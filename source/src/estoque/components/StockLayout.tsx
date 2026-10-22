import { useEffect, useState, type ReactNode } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { LayoutDashboard, ListFilter, SlidersHorizontal } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useGlobalFilters } from "@/hooks/use-filters";
import { appContextQuery } from "@/lib/queries";
import type { CompanyFilter } from "../api/contract";
import { StockContext, canOpenStock } from "../lib/hooks";
import { Notice } from "./shared";

const navigation = [
  { to: "/estoque", label: "Visão geral", icon: LayoutDashboard, exact: true },
  { to: "/estoque/posicoes", label: "Posições", icon: ListFilter, exact: false },
  { to: "/estoque/simulacao", label: "Simulação", icon: SlidersHorizontal, exact: false },
] as const;

type Scope = "company" | "all";
const SCOPE_KEY = "biomie.estoque.escopo";

/** Preferência só deste navegador; sem acesso ao armazenamento, vale a empresa do filtro. */
function readScope(): Scope {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "company";
  } catch {
    return "company";
  }
}

/** Estoque dentro do BIOMIE: segue a empresa do filtro do topo ou junta todas as do usuário. */
export function StockLayout() {
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const { resolved, company } = useGlobalFilters();
  const [scope, setScope] = useState<Scope>("company");
  useEffect(() => setScope(readScope()), []);
  function choose(next: Scope) {
    setScope(next);
    try {
      window.localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* sem armazenamento: a escolha vale até recarregar */
    }
  }
  if (!canOpenStock(ctx))
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-6">
        <Notice>O módulo Estoque ainda não foi liberado para o seu perfil.</Notice>
      </main>
    );
  const companyId: CompanyFilter = scope === "all" || !resolved ? "all" : resolved.company;
  return (
    <StockContext.Provider
      value={{ companyId, setCompanyId: (v) => choose(v === "all" ? "all" : "company") }}
    >
      <main
        id="stock-main"
        className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-7 px-4 py-6 md:px-6 md:py-8"
      >
        <div className="flex flex-col justify-between gap-4 border-b pb-5 md:flex-row md:items-end">
          <nav aria-label="Estoque" className="flex flex-wrap gap-1">
            {navigation.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: n.exact }}
                className="flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
                activeProps={{ className: "bg-accent text-accent-foreground font-semibold" }}
              >
                <n.icon className="size-4" aria-hidden />
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="min-w-0 space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground">Empresas</span>
            <ToggleGroup
              type="single"
              variant="outline"
              value={scope}
              onValueChange={(v) => v && choose(v as Scope)}
              aria-label="Empresas do estoque"
              className="flex-wrap justify-start"
            >
              <ToggleGroupItem value="company" className="min-h-11 max-w-[18rem] px-3">
                <span className="truncate">{company?.name ?? "Empresa do filtro"}</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="all" className="min-h-11 px-3">
                Todas as minhas empresas
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        <p className="-mt-3 text-xs text-muted-foreground">
          Posição da última leitura do Omie. O período e o canal do filtro não se aplicam ao
          estoque.
        </p>
        {scope === "company" && company?.isDemo && (
          <Notice>
            A empresa selecionada é de demonstração e não tem estoque. Escolha outra empresa no
            filtro do topo ou veja todas as suas empresas.
          </Notice>
        )}
        <Outlet />
      </main>
    </StockContext.Provider>
  );
}

export function PageTitle({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
