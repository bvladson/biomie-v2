import { Link, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Gauge, Info, LayoutDashboard, Map, Target, Wrench } from "lucide-react";
import { bootstrap } from "../api/server-client";
import { FlightPlanContext, useFilters } from "../lib/hooks";
import { monthLabel } from "../lib/format";
import { ErrorState, Loading } from "./bits";
import { keepSearch } from "@/components/entities/shared";
import { useGlobalFilters } from "@/hooks/use-filters";

const TABS = [
  { to: "/plano-de-voo", label: "Visão geral", icon: LayoutDashboard },
  { to: "/plano-de-voo/destino", label: "Destino", icon: Target },
  { to: "/plano-de-voo/rota", label: "Rota", icon: Map },
  { to: "/plano-de-voo/velocidade", label: "Velocidade", icon: Gauge },
  { to: "/plano-de-voo/painel", label: "Painel", icon: BarChart3 },
  { to: "/plano-de-voo/correcao", label: "Correção de rota", icon: Wrench },
] as const;

/** Layout das seis abas do Plano de Voo, dentro do shell do BIOMIE (filtros globais no topo). */
export function FlightPlanShell() {
  const boot = useQuery({
    queryKey: ["fp", "bootstrap"],
    queryFn: () => bootstrap(),
    staleTime: 5 * 60_000,
  });
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-4 py-6 md:px-6 md:py-8">
      {boot.isPending ? (
        <Loading label="Carregando o Plano de Voo…" />
      ) : boot.isError ? (
        <ErrorState error={boot.error} retry={() => boot.refetch()} />
      ) : boot.data.companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma empresa liberada para o Plano de Voo.
        </p>
      ) : (
        <FlightPlanContext.Provider value={boot.data}>
          <Header />
          <nav aria-label="Pilares do Plano de Voo" className="flex gap-1 overflow-x-auto border-b">
            {TABS.map((t) => (
              <Link
                key={t.to}
                to={t.to}
                search={keepSearch}
                activeOptions={{ exact: true, includeSearch: false }}
                className="flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground"
                activeProps={{
                  className: "!border-primary font-semibold !text-foreground",
                  "aria-current": "page",
                }}
              >
                <t.icon className="size-4" aria-hidden />
                {t.label}
              </Link>
            ))}
          </nav>
          <section id="fp-main" className="min-w-0">
            <Outlet />
          </section>
        </FlightPlanContext.Provider>
      )}
    </main>
  );
}

function Header() {
  const f = useFilters();
  const { company } = useGlobalFilters();
  const notes: string[] = [];
  if (f.unsupportedChannel)
    notes.push(
      "O canal escolhido não tem Plano de Voo (só Varejo e Licitação): mostrando todos os canais.",
    );
  if (f.extraFilters)
    notes.push(
      "Filial, UF, cidade ou categoria mudam o realizado e a carteira; a meta não é dividida por esses filtros.",
    );
  return (
    <header className="flex flex-col gap-2">
      <div className="eyebrow">
        {f.company.name} · {monthLabel(f.month)}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Plano de Voo Comercial</h1>
        <p className="text-xs text-muted-foreground">
          Dados até{" "}
          <span className="fp-num">
            {(company?.dataAsOf ?? f.company.asOf).split("-").reverse().join("/")}
          </span>
        </p>
      </div>
      {notes.map((n) => (
        <p
          key={n}
          role="note"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm text-warning"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {n}
        </p>
      ))}
    </header>
  );
}
