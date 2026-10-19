import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGlobalFilters } from "@/hooks/use-filters";
import { parsePeriod } from "@/domain/filters";
import { monthLabel } from "@/domain/format";
import { SalesSummary } from "@/components/sales/SalesSummary";
import { SalesDrivers } from "@/components/sales/SalesDrivers";
import { SalesEvolution } from "@/components/sales/SalesEvolution";
import { InvoicesTab, ItemsTab, OrdersTab } from "@/components/sales/SalesTables";
import type { Dimension } from "@/lib/repositories/sales.repository.server";

const TABS = ["resumo", "evolucao", "notas", "pedidos", "itens"] as const;
const DIMS = ["seller", "customer", "product", "category", "state", "city"] as const;

export const Route = createFileRoute("/_authenticated/_shell/vendas")({
  validateSearch: z.object({
    tab: z.enum(TABS).optional().catch(undefined),
    dim: z.enum(DIMS).optional().catch(undefined),
  }),
  head: () => ({
    meta: [
      { title: "Vendas — BIOMIE" },
      { name: "description", content: "Faturamento, evolução, drivers, notas, pedidos e itens." },
      { property: "og:title", content: "Vendas — BIOMIE" },
      {
        property: "og:description",
        content: "Faturamento, evolução, drivers, notas, pedidos e itens.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VendasPage,
});

function VendasPage() {
  const { resolved, company } = useGlobalFilters();
  const { tab = "resumo", dim = "seller" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!resolved) return null;
  const { year, month } = parsePeriod(resolved.period);
  const set = (p: { tab?: (typeof TABS)[number]; dim?: Dimension }) =>
    navigate({ search: (s) => ({ ...s, ...p }), replace: true });

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header>
        <p className="eyebrow">{company?.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Vendas — {monthLabel(year, month)}
        </h1>
      </header>
      <Tabs value={tab} onValueChange={(v) => set({ tab: v as (typeof TABS)[number] })}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="resumo">Resumo</TabsTrigger>
          <TabsTrigger value="evolucao">Evolução</TabsTrigger>
          <TabsTrigger value="notas">Notas Fiscais</TabsTrigger>
          <TabsTrigger value="pedidos">Pedidos</TabsTrigger>
          <TabsTrigger value="itens">Itens</TabsTrigger>
        </TabsList>
        <TabsContent value="resumo" className="mt-4 flex flex-col gap-6">
          <SalesSummary q={resolved} />
          <SalesDrivers q={resolved} dim={dim} onDim={(d) => set({ dim: d })} />
        </TabsContent>
        <TabsContent value="evolucao" className="mt-4 flex flex-col gap-6">
          <SalesEvolution q={resolved} />
          <SalesDrivers q={resolved} dim={dim} onDim={(d) => set({ dim: d })} />
        </TabsContent>
        <TabsContent value="notas" className="panel mt-4">
          <InvoicesTab q={resolved} />
        </TabsContent>
        <TabsContent value="pedidos" className="panel mt-4">
          <OrdersTab q={resolved} />
        </TabsContent>
        <TabsContent value="itens" className="panel mt-4">
          <ItemsTab q={resolved} />
        </TabsContent>
      </Tabs>
    </main>
  );
}
