import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useGlobalFilters } from "@/hooks/use-filters";
import { flightPlanQuery } from "@/lib/queries";
import { VendorsTable } from "@/components/flight-plan/VendorsTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { exportName } from "@/lib/export";
import { STATUS_META, type FlightStatus } from "@/domain/flight-plan/config";
import { parsePeriod } from "@/domain/filters";
import { monthLabel } from "@/domain/format";
import type { VendorRow } from "@/lib/repositories/flight-plan.repository.server";

export const Route = createFileRoute("/_authenticated/_shell/vendedores/")({
  head: () => ({
    meta: [
      { title: "Vendedores — BIOMIE" },
      {
        name: "description",
        content: "Desempenho de cada vendedor frente à meta e acesso ao Vendedor 360.",
      },
      { property: "og:title", content: "Vendedores — BIOMIE" },
      {
        property: "og:description",
        content: "Desempenho de cada vendedor frente à meta e acesso ao Vendedor 360.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VendedoresPage,
});

const vendorExport = [
  { header: "Vendedor", value: (v: VendorRow) => v.name },
  {
    header: "Status",
    value: (v: VendorRow) => (v.metrics.status ? STATUS_META[v.metrics.status].label : null),
  },
  { header: "Meta", value: (v: VendorRow) => v.metrics.target },
  { header: "Realizado", value: (v: VendorRow) => v.metrics.realized },
  { header: "Atingimento", value: (v: VendorRow) => v.metrics.attainment },
  { header: "Ideal até hoje", value: (v: VendorRow) => v.metrics.idealToday },
  { header: "Desvio", value: (v: VendorRow) => v.metrics.deviation },
  { header: "Gap", value: (v: VendorRow) => v.metrics.remainingGap },
  { header: "Ritmo necessário/dia", value: (v: VendorRow) => v.metrics.requiredDailyPace },
  { header: "Forecast provável", value: (v: VendorRow) => v.metrics.forecastProbable },
  { header: "Carteira", value: (v: VendorRow) => v.metrics.portfolio },
  { header: "Cobertura", value: (v: VendorRow) => v.metrics.gapCoverage },
  { header: "NFs", value: (v: VendorRow) => v.invoices },
];

function VendedoresPage() {
  const { resolved, company } = useGlobalFilters();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<FlightStatus | "ALL">("ALL");
  const { data, isPending, error } = useQuery({
    ...flightPlanQuery(resolved!),
    enabled: !!resolved,
  });
  if (!resolved) return null;
  const term = search.trim().toLowerCase();
  const visibleVendors = (data?.vendors ?? []).filter(
    (vendor) =>
      (!term || vendor.name.toLowerCase().includes(term)) &&
      (status === "ALL" || vendor.metrics.status === status),
  );
  const { year, month } = parsePeriod(resolved.period);
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <p className="eyebrow">{company?.name}</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Vendedores — {monthLabel(year, month)}
          </h1>
        </div>
        <div className="ml-auto">
          <ExportMenu
            rows={visibleVendors}
            columns={vendorExport}
            name={exportName("vendedores", resolved)}
          />
        </div>
      </header>
      <section className="panel">
        {error ? (
          <p className="p-6 text-sm text-muted-foreground">{error.message}</p>
        ) : isPending || !data ? (
          <Skeleton className="m-4 h-64" />
        ) : (
          <VendorsTable
            vendors={data.vendors}
            onSelect={(id) =>
              navigate({
                to: "/vendedores/$sellerId",
                params: { sellerId: id },
                search: ((p: object) => p) as never,
              })
            }
            search={search}
            status={status}
            onSearch={setSearch}
            onStatus={setStatus}
          />
        )}
      </section>
    </main>
  );
}
