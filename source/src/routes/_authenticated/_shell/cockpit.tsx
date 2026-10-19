import { TARGET_LEVEL_LABELS } from "@/domain/flight-plan/config";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { KpiCard, KpiSkeleton } from "@/components/analytics/KpiCard";
import { FlightChart } from "@/components/analytics/FlightChart";
import { SellersTable } from "@/components/analytics/SellersTable";
import { RankList } from "@/components/analytics/RankList";
import { Skeleton } from "@/components/ui/skeleton";
import { useGlobalFilters } from "@/hooks/use-filters";
import { cockpitQuery } from "@/lib/queries";
import { parsePeriod } from "@/domain/filters";
import { monthLabel } from "@/domain/format";

export const Route = createFileRoute("/_authenticated/_shell/cockpit")({
  head: () => ({
    meta: [
      { title: "Visão Geral — BIOMIE" },
      {
        name: "description",
        content: "Cockpit executivo: faturamento, meta, forecast e carteira.",
      },
      { property: "og:title", content: "Visão Geral — BIOMIE" },
      {
        property: "og:description",
        content: "Cockpit executivo: faturamento, meta, forecast e carteira.",
      },
    ],
  }),
  component: CockpitPage,
});

const PRIMARY = ["revenue", "target", "target_attainment", "forecast", "portfolio"];
const SECONDARY = ["average_ticket", "customers", "orders", "working_days", "daily_required"];

function CockpitPage() {
  const { resolved } = useGlobalFilters();
  const q = resolved!;
  const { data, isPending, error, isFetching } = useQuery({
    ...cockpitQuery(q),
    placeholderData: (prev) => prev,
  });
  const { year, month } = parsePeriod(q.period);
  const expectedPace =
    data && data.workingDays.total ? data.workingDays.elapsed / data.workingDays.total : 0;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="eyebrow">Cockpit · {monthLabel(year, month)}</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Visão Geral</h1>
        </div>
        {isFetching && !isPending && (
          <span className="text-xs text-muted-foreground">Atualizando…</span>
        )}
      </div>

      {error ? (
        <div className="panel p-8 text-center text-sm text-muted-foreground">{error.message}</div>
      ) : (
        <>
          <section className="panel grid grid-cols-2 divide-border md:grid-cols-5 md:divide-x">
            {PRIMARY.map((k) =>
              isPending || !data ? (
                <KpiSkeleton key={k} />
              ) : (
                <KpiCard key={k} kpi={data.kpis[k]!} emphasis />
              ),
            )}
          </section>
          <section className="panel grid grid-cols-2 divide-border md:grid-cols-5 md:divide-x">
            {SECONDARY.map((k) =>
              isPending || !data ? (
                <KpiSkeleton key={k} />
              ) : (
                <KpiCard key={k} kpi={data.kpis[k]!} />
              ),
            )}
          </section>

          <section className="panel p-4 md:p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">Plano de voo do mês</h2>
                <p className="text-xs text-muted-foreground">
                  Faturamento acumulado vs linha da meta distribuída por dias úteis
                  {data && <> · Referência: {TARGET_LEVEL_LABELS[data.targetLevel]}</>}
                </p>
              </div>
            </div>
            {isPending || !data ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <FlightChart daily={data.daily} />
            )}
          </section>

          <section className="panel overflow-hidden">
            <div className="border-b px-4 py-3 md:px-5">
              <h2 className="text-base font-semibold">Performance dos vendedores</h2>
              <p className="text-xs text-muted-foreground">
                Marcador vertical = ritmo esperado para hoje ({Math.round(expectedPace * 100)}% dos
                dias úteis)
              </p>
            </div>
            {isPending || !data ? (
              <Skeleton className="m-4 h-48" />
            ) : (
              <SellersTable sellers={data.sellers} expectedPace={expectedPace} />
            )}
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold">Drivers do resultado</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {isPending || !data ? (
                Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-64" />)
              ) : (
                <>
                  <RankList title="Produtos" items={data.drivers.products} />
                  <RankList title="Clientes" items={data.drivers.customers} />
                  <RankList title="Categorias" items={data.drivers.categories} />
                  <RankList title="Geografia (UF)" items={data.drivers.states} />
                </>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
