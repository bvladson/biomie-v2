import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { LayoutDashboard, Lightbulb, ListFilter, SlidersHorizontal, Truck } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useGlobalFilters } from "@/hooks/use-filters";
import { appContextQuery } from "@/lib/queries";
import type { CompanyFilter, CurveWindow } from "../api/contract";
import { StockContext, canOpenStock } from "../lib/hooks";
import { CURVE_WINDOWS, DEFAULT_WINDOW, WINDOW_LABELS, isCurveWindow } from "../lib/curves";
import { intelApi } from "../api/intel";
import { stockApi } from "../api";
import { Notice } from "./shared";
import { SupplierPicker } from "./SupplierPicker";

const navigation = [
  { to: "/estoque", label: "Visão geral", icon: LayoutDashboard, exact: true },
  { to: "/estoque/inteligencia", label: "Inteligência", icon: Lightbulb, exact: false },
  { to: "/estoque/posicoes", label: "Posições", icon: ListFilter, exact: false },
  { to: "/estoque/simulacao", label: "Simulação", icon: SlidersHorizontal, exact: false },
  { to: "/estoque/fornecedores", label: "Fornecedores e prazos", icon: Truck, exact: false },
] as const;

type Scope = "company" | "all";
const SCOPE_KEY = "biomie.estoque.escopo";
const WINDOW_KEY = "biomie.estoque.janela";

/** Preferência só deste navegador; sem acesso ao armazenamento, vale a empresa do filtro. */
function readScope(): Scope {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "company";
  } catch {
    return "company";
  }
}

function readWindow(): CurveWindow {
  try {
    const saved = window.localStorage.getItem(WINDOW_KEY);
    return isCurveWindow(saved) ? saved : DEFAULT_WINDOW;
  } catch {
    return DEFAULT_WINDOW;
  }
}

/** Estoque dentro do BIOMIE: segue a empresa do filtro do topo ou junta todas as do usuário. */
export function StockLayout() {
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const { resolved, company } = useGlobalFilters();
  const [scope, setScope] = useState<Scope>("company");
  const [curveWindow, setCurveWindow] = useState<CurveWindow>(DEFAULT_WINDOW);
  const [supplier, setSupplier] = useState<string | undefined>(undefined);
  const allowed = canOpenStock(ctx);
  const isSuper = ctx.roles.includes("SUPER_ADMIN");
  // A aba Inteligência aparece quando o motor está ligado ou já publicou (o Super admin sempre vê).
  const intel = useQuery({
    queryKey: ["stock", "intel", "status"],
    queryFn: () => intelApi.status(),
    enabled: allowed && !isSuper,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const showIntel =
    isSuper || intel.data?.enabled === true || (intel.data?.current.length ?? 0) > 0;
  useEffect(() => {
    setScope(readScope());
    setCurveWindow(readWindow());
  }, []);
  function choose(next: Scope) {
    setScope(next);
    try {
      window.localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* sem armazenamento: a escolha vale até recarregar */
    }
  }
  function chooseWindow(next: CurveWindow) {
    setCurveWindow(next);
    try {
      window.localStorage.setItem(WINDOW_KEY, next);
    } catch {
      /* sem armazenamento: a escolha vale até recarregar */
    }
  }
  if (!allowed)
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-6">
        <Notice>O módulo Estoque ainda não foi liberado para o seu perfil.</Notice>
      </main>
    );
  const companyId: CompanyFilter = scope === "all" || !resolved ? "all" : resolved.company;
  return (
    <StockShell
      companyId={companyId}
      scope={scope}
      choose={choose}
      curveWindow={curveWindow}
      chooseWindow={chooseWindow}
      supplier={supplier}
      setSupplier={setSupplier}
      showIntel={showIntel}
      companyName={company?.name}
      isDemo={scope === "company" && Boolean(company?.isDemo)}
    />
  );
}

function StockShell({
  companyId,
  scope,
  choose,
  curveWindow,
  chooseWindow,
  supplier,
  setSupplier,
  showIntel,
  companyName,
  isDemo,
}: {
  companyId: CompanyFilter;
  scope: Scope;
  choose: (s: Scope) => void;
  curveWindow: CurveWindow;
  chooseWindow: (w: CurveWindow) => void;
  supplier: string | undefined;
  setSupplier: (v: string | undefined) => void;
  showIntel: boolean;
  companyName: string | undefined;
  isDemo: boolean;
}) {
  // Fornecedores da empresa (o código é de cada conta do Omie): com "todas", o filtro fica desligado.
  const options = useQuery({
    queryKey: ["stock", "options", companyId],
    queryFn: () => stockApi.filterOptions(companyId),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const suppliers = useMemo(() => options.data?.suppliers ?? [], [options.data]);
  const needsCompany = companyId === "all" && (options.data?.suppliersNeedCompany ?? true);
  // Trocou de empresa (ou o fornecedor não é desta): o filtro sai.
  useEffect(() => {
    if (supplier && (needsCompany || (options.data && !suppliers.some((s) => s.id === supplier))))
      setSupplier(undefined);
  }, [supplier, needsCompany, options.data, suppliers, setSupplier]);
  const supplierName = suppliers.find((s) => s.id === supplier)?.name;
  return (
    <StockContext.Provider
      value={{
        companyId,
        setCompanyId: (v) => choose(v === "all" ? "all" : "company"),
        window: curveWindow,
        setWindow: chooseWindow,
        supplier: supplierName ? supplier : undefined,
        supplierName,
        setSupplier,
      }}
    >
      <main
        id="stock-main"
        className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-7 px-4 py-6 md:px-6 md:py-8"
      >
        <div className="flex flex-col justify-between gap-4 border-b pb-5 md:flex-row md:items-end">
          <nav aria-label="Estoque" className="flex flex-wrap gap-1">
            {navigation
              .filter((n) => n.to !== "/estoque/inteligencia" || showIntel)
              .map((n) => (
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
                <span className="truncate">{companyName ?? "Empresa do filtro"}</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="all" className="min-h-11 px-3">
                Todas as minhas empresas
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        <div className="-mt-3 flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <p className="text-xs text-muted-foreground">
            Posição da última leitura do Omie. O período e o canal do filtro não se aplicam ao
            estoque. A curva A/B/C/D vem do faturamento da janela escolhida (a mesma base da página
            Produtos); D = saldo positivo sem venda na janela.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <SupplierPicker
              options={suppliers}
              value={supplierName ? supplier : undefined}
              onChange={setSupplier}
              needsCompany={needsCompany}
              loading={options.isLoading}
            />
            <div className="min-w-0 space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">
                Janela da curva
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                value={curveWindow}
                onValueChange={(v) => isCurveWindow(v) && chooseWindow(v)}
                aria-label="Janela da curva"
                className="flex-wrap justify-start"
              >
                {CURVE_WINDOWS.map((w) => (
                  <ToggleGroupItem key={w} value={w} className="min-h-11 px-3">
                    {WINDOW_LABELS[w]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
        </div>
        {supplierName && (
          <p className="-mt-3 text-sm" role="status">
            Filtrando pelo fornecedor <strong>{supplierName}</strong>: painel, posições, radar e
            reposição mostram só os produtos vinculados a ele nesta empresa.
          </p>
        )}
        {isDemo && (
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
