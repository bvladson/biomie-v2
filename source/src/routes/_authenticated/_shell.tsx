import { createFileRoute, Outlet, retainSearchParams } from "@tanstack/react-router";
import { FlaskConical } from "lucide-react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { FilterBar } from "@/components/layout/FilterBar";
import { globalFiltersSchema } from "@/domain/filters";
import { appContextQuery } from "@/lib/queries";
import { useGlobalFilters } from "@/hooks/use-filters";

export const Route = createFileRoute("/_authenticated/_shell")({
  validateSearch: globalFiltersSchema,
  search: { middlewares: [retainSearchParams(true)] },
  loader: ({ context }) => context.queryClient.ensureQueryData(appContextQuery()),
  component: ShellLayout,
  errorComponent: ({ error }) => (
    <div className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">
      Não foi possível carregar sua conta:{" "}
      {error instanceof Error ? error.message : "erro inesperado"}
    </div>
  ),
});

function DemoBanner() {
  const { company } = useGlobalFilters();
  if (!company?.isDemo) return null;
  const [y, m, d] = (company.dataAsOf || "").split("-");
  return (
    <div className="flex items-center gap-3">
      {company.dataAsOf && (
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          Dados demonstrativos posicionados em {d}/{m}/{y}
        </span>
      )}
      <div className="flex items-center gap-2 rounded-md bg-demo px-2.5 py-1 text-[11px] font-semibold tracking-wide text-demo-foreground">
        <FlaskConical className="size-3.5" /> MODO DEMONSTRAÇÃO
      </div>
    </div>
  );
}

function NoCompany() {
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center">
      <div className="max-w-sm">
        <h2 className="text-lg font-semibold">Nenhuma empresa liberada</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Peça a um administrador para liberar o acesso a pelo menos uma empresa.
        </p>
      </div>
    </div>
  );
}

function ShellLayout() {
  const { resolved } = useGlobalFilters();
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 md:px-6">
            <SidebarTrigger className="-ml-1" />
            <div className="h-4 w-px bg-border" />
            <span className="text-sm font-medium text-muted-foreground">BIOMIE</span>
            <div className="ml-auto">
              <DemoBanner />
            </div>
          </div>
          {resolved && (
            <div className="border-t px-4 py-2.5 md:px-6">
              <FilterBar />
            </div>
          )}
        </header>
        {resolved ? <Outlet /> : <NoCompany />}
      </SidebarInset>
    </SidebarProvider>
  );
}
