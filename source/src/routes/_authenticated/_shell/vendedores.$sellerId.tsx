import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { keepSearch } from "@/components/entities/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useGlobalFilters } from "@/hooks/use-filters";
import { appContextQuery, vendor360Query } from "@/lib/queries";
import { parsePeriod } from "@/domain/filters";
import { formatValue, monthLabel } from "@/domain/format";
import { hasPermission } from "@/domain/rbac";
import { TARGET_LEVEL_LABELS } from "@/domain/flight-plan/config";
import { FpKpi, StatusBadge, signTone } from "@/components/flight-plan/parts";
import { FlightPlanChart } from "@/components/flight-plan/FlightPlanChart";
import { ActionsPanel } from "@/components/flight-plan/ActionsPanel";
import { DataTable } from "@/components/analytics/DataTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { breakdownColumns, breakdownExport } from "@/components/sales/SalesDrivers";
import { exportName } from "@/lib/export";

export const Route = createFileRoute("/_authenticated/_shell/vendedores/$sellerId")({
  head: () => ({
    meta: [
      { title: "Vendedor 360 — BIOMIE" },
      {
        name: "description",
        content: "Visão completa do vendedor: plano de voo, histórico, clientes e produtos.",
      },
      { property: "og:title", content: "Vendedor 360 — BIOMIE" },
      {
        property: "og:description",
        content: "Visão completa do vendedor: plano de voo, histórico, clientes e produtos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Vendor360Page,
});

function Vendor360Page() {
  const { sellerId } = Route.useParams();
  const navigate = useNavigate();
  const { resolved, company } = useGlobalFilters();
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const q = { ...resolved!, seller: sellerId };
  const { data, isPending, error } = useQuery({ ...vendor360Query(q), enabled: !!resolved });
  if (!resolved) return null;
  const { year, month } = parsePeriod(resolved.period);

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link
        to="/vendedores"
        search={((p: Record<string, unknown>) => ({ ...p, seller: undefined })) as never}
      >
        <ArrowLeft className="size-4" /> Vendedores
      </Link>
    </Button>
  );
  if (error)
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-6">
        {back}
        <p className="mt-6 text-sm text-muted-foreground">{error.message}</p>
      </main>
    );
  if (isPending || !data)
    return (
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-8 md:px-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-80" />
      </main>
    );

  const v = data.plan.vendors[0]!;
  const m = v.metrics;
  const k = data.kpis;
  const canWrite = hasPermission(ctx.roles, "flightplan:write");
  const hist = data.history.map((h) => ({
    label: `${h.month.slice(5, 7)}/${h.month.slice(2, 4)}`,
    Faturamento: h.revenue,
    Meta: h.target || null,
    attainment: h.attainment,
  }));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      {back}
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <p className="eyebrow">
            {company?.name} · Equipe: {data.team ?? "—"} · {monthLabel(year, month)}
          </p>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{v.name}</h1>
            <StatusBadge status={m.status} />
          </div>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          Referência: {TARGET_LEVEL_LABELS[data.plan.config.activeLevel]}
        </span>
      </header>

      <section
        aria-label="Indicadores do vendedor"
        className="panel grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6"
      >
        <FpKpi metricKey="revenue" value={k.revenue} />
        <FpKpi metricKey="target" label="Meta" value={k.target} />
        <FpKpi metricKey="target_attainment" value={k.target_attainment} />
        <FpKpi metricKey="remaining_gap" label="Gap" value={m.remainingGap} />
        <FpKpi metricKey="forecast_probable" label="Forecast" value={m.forecastProbable} />
        <FpKpi metricKey="forecast_commit" label="Commit" value={m.forecastCommit} />
        <FpKpi metricKey="portfolio" value={m.portfolio} sub={`${v.orders} pedidos`} />
        <FpKpi metricKey="gap_coverage" label="Cobertura" value={m.gapCoverage} />
        <FpKpi metricKey="average_ticket" value={k.average_ticket} />
        <FpKpi metricKey="customers" value={k.customers} />
        <FpKpi metricKey="sales_orders_count" value={k.sales_orders_count} />
        <FpKpi metricKey="orders" label="NFs" value={k.orders} />
      </section>

      <section className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">Plano de Voo individual</h2>
          <span className="text-xs text-muted-foreground">
            Ideal até hoje {formatValue(m.idealToday, "currency")} · desvio{" "}
            <span className={signTone(m.deviation) === "bad" ? "text-destructive" : "text-success"}>
              {formatValue(m.deviation, "currency")}
            </span>{" "}
            · run-rate {formatValue(m.runRateForecast, "currency")}
          </span>
        </div>
        <FlightPlanChart
          timeline={data.plan.timeline}
          target={m.target}
          today={data.plan.period.today}
          height={300}
        />
      </section>

      <section className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center gap-4">
          <h2 className="text-sm font-semibold">Histórico — últimos 12 meses</h2>
          {(
            [
              ["Média 3m", data.averages.m3],
              ["Média 6m", data.averages.m6],
              ["Média 12m", data.averages.m12],
            ] as const
          ).map(([l, val]) => (
            <span key={l} className="text-xs text-muted-foreground">
              {l}: <b className="text-foreground tabular">{formatValue(val, "currency")}</b>
            </span>
          ))}
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={hist}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
              <YAxis
                yAxisId="v"
                width={70}
                tick={{ fontSize: 11 }}
                stroke="var(--muted-foreground)"
                tickFormatter={(x: number) => formatValue(x, "currency_compact")}
              />
              <YAxis
                yAxisId="p"
                orientation="right"
                width={45}
                tick={{ fontSize: 11 }}
                stroke="var(--muted-foreground)"
                tickFormatter={(x: number) => `${Math.round(x * 100)}%`}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  fontSize: 12,
                }}
                formatter={(val: number, name: string) =>
                  name === "Atingimento"
                    ? formatValue(val, "percent")
                    : formatValue(val, "currency")
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="v" dataKey="Faturamento" fill="var(--primary)" radius={[3, 3, 0, 0]} />
              <Line
                yAxisId="v"
                dataKey="Meta"
                stroke="var(--muted-foreground)"
                strokeDasharray="5 4"
                dot={false}
              />
              <Line
                yAxisId="p"
                dataKey="attainment"
                name="Atingimento"
                stroke="var(--warning)"
                dot={{ r: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="panel">
          <div className="flex items-center border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Clientes do vendedor</h2>
            <div className="ml-auto">
              <ExportMenu
                rows={data.customers}
                columns={breakdownExport("customer")}
                name={exportName("vendedor-clientes", q)}
              />
            </div>
          </div>
          <DataTable
            rows={data.customers}
            columns={breakdownColumns("customer", { lastDate: true }).filter(
              (c) => c.key !== "variation" && c.key !== "units",
            )}
            rowKey={(r, i) => r.key ?? String(i)}
            search={(r) => r.label ?? ""}
            onRowClick={(r) =>
              r.key &&
              navigate({
                to: "/clientes/$customerId",
                params: { customerId: r.key },
                search: keepSearch,
              })
            }
            pageSize={15}
          />
        </section>
        <section className="panel">
          <div className="flex items-center border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Produtos do vendedor</h2>
            <div className="ml-auto">
              <ExportMenu
                rows={data.products}
                columns={breakdownExport("product")}
                name={exportName("vendedor-produtos", q)}
              />
            </div>
          </div>
          <DataTable
            rows={data.products}
            columns={breakdownColumns("product").filter(
              (c) => c.key !== "variation" && c.key !== "invoices",
            )}
            rowKey={(r, i) => r.key ?? String(i)}
            search={(r) => `${r.label} ${r.sub ?? ""}`}
            onRowClick={(r) =>
              r.key &&
              navigate({
                to: "/produtos/$productId",
                params: { productId: r.key },
                search: keepSearch,
              })
            }
            pageSize={15}
          />
        </section>
      </div>

      <section className="panel">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Ações prioritárias</h2>
        <ActionsPanel
          actions={data.plan.actions}
          company={resolved.company}
          period={resolved.period}
          canWrite={canWrite}
        />
      </section>
    </main>
  );
}
