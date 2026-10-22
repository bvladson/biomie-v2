import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ProductStockCard } from "@/estoque/components/ProductStockCard";
import { canOpenStock } from "@/estoque/lib/hooks";
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
import { useGlobalFilters } from "@/hooks/use-filters";
import { appContextQuery, product360Query } from "@/lib/queries";
import { formatValue } from "@/domain/format";
import { FpKpi } from "@/components/flight-plan/parts";
import { DataTable } from "@/components/analytics/DataTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { exportName } from "@/lib/export";
import {
  BackLink,
  fmtDate,
  keepSearch,
  pageHead,
  PageSkeleton,
  Panel,
  UNASSIGNED,
  withSearch,
} from "@/components/entities/shared";

export const Route = createFileRoute("/_authenticated/_shell/produtos/$productId")({
  head: () => pageHead("Produto 360", "Histórico, clientes e vendedores de cada produto."),
  component: Product360Page,
});

function Product360Page() {
  const { productId } = Route.useParams();
  const { resolved } = useGlobalFilters();
  const navigate = useNavigate();
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const [grain, setGrain] = useState<"month" | "week">("month");
  const q = { ...resolved!, product: productId, grain };
  const { data, isPending, error } = useQuery({ ...product360Query(q), enabled: !!resolved });
  if (!resolved) return null;
  if (error)
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-6">
        <BackLink to="/produtos" label="Produtos" />
        <p className="mt-6 text-sm text-muted-foreground">{error.message}</p>
      </main>
    );
  if (isPending || !data) return <PageSkeleton />;
  const p = data.product;
  const k = data.kpis;
  const hist = data.history.map((h) => ({
    ...h,
    label:
      grain === "month"
        ? `${h.bucket.slice(5, 7)}/${h.bucket.slice(2, 4)}`
        : fmtDate(h.bucket).slice(0, 5),
  }));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <BackLink to="/produtos" label="Produtos" />
      <header>
        <p className="eyebrow">
          <span className="font-mono">{p.sku ?? "sem SKU"}</span> ·{" "}
          <Link
            to="/vendas"
            search={withSearch({ category: p.category })}
            className="hover:underline"
          >
            {p.category}
          </Link>{" "}
          · Última venda {fmtDate(p.lastSale)}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
      </header>
      <section className="panel grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <FpKpi metricKey="product_revenue" value={k.revenue} />
        <FpKpi metricKey="product_units" value={k.units} />
        <FpKpi metricKey="product_average_price" value={k.avgPrice} />
        <FpKpi metricKey="product_customer_count" value={k.customers} />
        <FpKpi metricKey="product_units" label="Vendedores" value={k.sellers} />
        <FpKpi metricKey="orders" label="NFs" value={k.invoices} />
      </section>
      {canOpenStock(ctx) && <ProductStockCard productId={productId} companyId={resolved.company} />}
      <Panel
        title="Histórico do produto"
        actions={
          <Tabs value={grain} onValueChange={(v) => setGrain(v as "month" | "week")}>
            <TabsList className="h-8">
              <TabsTrigger value="month" className="text-xs">
                Mensal (12m)
              </TabsTrigger>
              <TabsTrigger value="week" className="text-xs">
                Semanal (26s)
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        <div className="h-72 p-4">
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
                yAxisId="u"
                orientation="right"
                width={35}
                tick={{ fontSize: 11 }}
                stroke="var(--muted-foreground)"
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  fontSize: 12,
                }}
                formatter={(v: number, name: string) =>
                  name === "Quantidade" ? formatValue(v, "integer") : formatValue(v, "currency")
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                yAxisId="v"
                dataKey="revenue"
                name="Faturamento"
                fill="var(--chart-1)"
                radius={[3, 3, 0, 0]}
              />
              <Line
                yAxisId="u"
                dataKey="units"
                name="Quantidade"
                stroke="var(--muted-foreground)"
                dot={{ r: 2 }}
              />
              <Line
                yAxisId="v"
                dataKey="avgPrice"
                name="Preço médio"
                stroke="var(--chart-2)"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Clientes do produto"
          actions={
            <ExportMenu
              rows={data.customers}
              name={exportName("produto-clientes", resolved)}
              columns={[
                { header: "Cliente", value: (r) => r.name },
                { header: "Cidade/UF", value: (r) => r.place },
                { header: "Quantidade", value: (r) => r.units },
                { header: "Faturamento", value: (r) => r.revenue },
                { header: "Preço médio", value: (r) => r.avgPrice },
                { header: "Última compra", value: (r) => r.lastDate },
                { header: "Participação", value: (r) => r.share },
              ]}
            />
          }
        >
          <DataTable
            rows={data.customers}
            rowKey={(r) => r.id}
            search={(r) => `${r.name} ${r.place}`}
            onRowClick={(r) =>
              navigate({
                to: "/clientes/$customerId",
                params: { customerId: r.id },
                search: keepSearch,
              })
            }
            pageSize={15}
            columns={[
              {
                key: "name",
                header: "Cliente",
                cell: (r) => <span className="font-medium">{r.name}</span>,
                sort: (r) => r.name,
              },
              {
                key: "units",
                header: "Qtd.",
                align: "right",
                cell: (r) => formatValue(r.units, "integer"),
                sort: (r) => r.units,
              },
              {
                key: "revenue",
                header: "Faturamento",
                align: "right",
                cell: (r) => formatValue(r.revenue, "currency"),
                sort: (r) => r.revenue,
              },
              {
                key: "avg",
                header: "Preço médio",
                align: "right",
                cell: (r) => formatValue(r.avgPrice, "currency"),
                sort: (r) => r.avgPrice,
              },
              {
                key: "last",
                header: "Última",
                align: "right",
                cell: (r) => fmtDate(r.lastDate),
                sort: (r) => r.lastDate,
              },
              {
                key: "share",
                header: "Part.",
                align: "right",
                cell: (r) => formatValue(r.share, "percent"),
                sort: (r) => r.share,
              },
            ]}
          />
        </Panel>
        <Panel
          title="Vendedores do produto"
          actions={
            <ExportMenu
              rows={data.sellers}
              name={exportName("produto-vendedores", resolved)}
              columns={[
                { header: "Vendedor", value: (r) => r.name ?? UNASSIGNED },
                { header: "Quantidade", value: (r) => r.units },
                { header: "Faturamento", value: (r) => r.revenue },
                { header: "Clientes", value: (r) => r.customers },
                { header: "Participação", value: (r) => r.share },
              ]}
            />
          }
        >
          <DataTable
            rows={data.sellers}
            rowKey={(r, i) => r.id ?? `na-${i}`}
            onRowClick={(r) =>
              r.id &&
              navigate({
                to: "/vendedores/$sellerId",
                params: { sellerId: r.id },
                search: keepSearch,
              })
            }
            pageSize={15}
            columns={[
              {
                key: "name",
                header: "Vendedor",
                cell: (r) => <span className="font-medium">{r.name ?? UNASSIGNED}</span>,
                sort: (r) => r.name ?? "",
              },
              {
                key: "units",
                header: "Qtd.",
                align: "right",
                cell: (r) => formatValue(r.units, "integer"),
                sort: (r) => r.units,
              },
              {
                key: "revenue",
                header: "Faturamento",
                align: "right",
                cell: (r) => formatValue(r.revenue, "currency"),
                sort: (r) => r.revenue,
              },
              {
                key: "customers",
                header: "Clientes",
                align: "right",
                cell: (r) => r.customers,
                sort: (r) => r.customers,
              },
              {
                key: "share",
                header: "Part.",
                align: "right",
                cell: (r) => formatValue(r.share, "percent"),
                sort: (r) => r.share,
              },
            ]}
          />
        </Panel>
      </div>
    </main>
  );
}
