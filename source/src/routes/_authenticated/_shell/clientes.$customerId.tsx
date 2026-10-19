import { CustomerFinance } from "@/components/finance/CustomerFinance";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useGlobalFilters } from "@/hooks/use-filters";
import { customer360Query } from "@/lib/queries";
import { formatValue, maskDocument } from "@/domain/format";
import { RFM_SEGMENT_LABELS } from "@/domain/customers/rfm";
import { FpKpi } from "@/components/flight-plan/parts";
import { DataTable } from "@/components/analytics/DataTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { InvoiceDrawer } from "@/components/sales/SalesTables";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { exportName } from "@/lib/export";
import { cn } from "@/lib/utils";
import {
  BackLink,
  fmtDate,
  keepSearch,
  pageHead,
  PageSkeleton,
  Panel,
  withSearch,
} from "@/components/entities/shared";

export const Route = createFileRoute("/_authenticated/_shell/clientes/$customerId")({
  head: () =>
    pageHead("Cliente 360", "Histórico, produtos, notas fiscais e comportamento RFM do cliente."),
  component: Customer360Page,
});

function Customer360Page() {
  const { customerId } = Route.useParams();
  const { resolved } = useGlobalFilters();
  const navigate = useNavigate();
  const [span, setSpan] = useState<"12" | "24">("12");
  const [invoice, setInvoice] = useState<string | null>(null);
  const q = { ...resolved!, customer: customerId };
  const { data, isPending, error } = useQuery({ ...customer360Query(q), enabled: !!resolved });
  if (!resolved) return null;
  if (error)
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-6">
        <BackLink to="/clientes" label="Clientes" />
        <p className="mt-6 text-sm text-muted-foreground">{error.message}</p>
      </main>
    );
  if (isPending || !data) return <PageSkeleton />;

  const c = data.customer;
  const k = data.kpis;
  const hist = data.history.slice(span === "12" ? -12 : -24).map((h) => ({
    ...h,
    label: `${h.month.slice(5, 7)}/${h.month.slice(2, 4)}`,
  }));

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <BackLink to="/clientes" label="Clientes" />
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <p className="eyebrow">
            {c.city}/{c.state} · {maskDocument(c.document)} · Vendedor:{" "}
            {c.sellerId ? (
              <Link
                to="/vendedores/$sellerId"
                params={{ sellerId: c.sellerId }}
                search={keepSearch}
                className="hover:underline"
              >
                {c.seller}
              </Link>
            ) : (
              "Não atribuído"
            )}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
          <p className="text-xs text-muted-foreground">
            Primeira compra {fmtDate(c.firstDate)} · Última compra histórica {fmtDate(c.lastDate)}
          </p>
        </div>
        {data.rfm && (
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            RFM <span className="font-mono text-foreground">{data.rfm.code}</span>
            <Badge variant="secondary">{RFM_SEGMENT_LABELS[data.rfm.segment]}</Badge>
          </div>
        )}
      </header>

      <section className="panel grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <FpKpi metricKey="customer_lifetime_revenue" value={k.lifetimeRevenue} />
        <FpKpi metricKey="revenue" label="Faturamento no período" value={k.revenue} />
        <FpKpi metricKey="sales_orders_count" value={k.orders} />
        <FpKpi metricKey="orders" label="NFs" value={k.invoices} />
        <FpKpi metricKey="average_ticket" value={k.ticket} />
        <FpKpi metricKey="customer_frequency" label="Frequência (12m)" value={k.frequency} />
        <FpKpi metricKey="customer_recency" value={k.recency} />
        <FpKpi metricKey="customer_monetary_value" label="Valor (12m)" value={k.monetary12m} />
        <FpKpi metricKey="product_units" label="Produtos distintos" value={k.products} />
        <FpKpi
          metricKey="revenue"
          label="Participação na empresa"
          value={k.share}
          format="percent"
        />
      </section>

      <Panel
        title="Histórico do cliente"
        actions={
          <Tabs value={span} onValueChange={(v) => setSpan(v as "12" | "24")}>
            <TabsList className="h-8">
              <TabsTrigger value="12" className="text-xs">
                12 meses
              </TabsTrigger>
              <TabsTrigger value="24" className="text-xs">
                24 meses
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        <div className="h-64 p-4">
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
                yAxisId="n"
                orientation="right"
                width={30}
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
                  name === "Compras" ? v : formatValue(v, "currency")
                }
              />
              <Bar
                yAxisId="v"
                dataKey="revenue"
                name="Faturamento"
                fill="var(--primary)"
                radius={[3, 3, 0, 0]}
              />
              <Line
                yAxisId="v"
                dataKey="ticket"
                name="Ticket"
                stroke="var(--warning)"
                dot={false}
                connectNulls={false}
              />
              <Line
                yAxisId="n"
                dataKey="invoices"
                name="Compras"
                stroke="var(--muted-foreground)"
                strokeDasharray="4 3"
                dot={{ r: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div
          className="flex flex-wrap items-center gap-1 px-4 pb-4"
          aria-label="Meses com e sem compra"
        >
          {hist.map((h) => (
            <span
              key={h.month}
              title={`${h.label}: ${h.invoices ? `${h.invoices} compra(s)` : "sem compra"}`}
              className={cn(
                "h-3 w-5 rounded-sm",
                h.invoices
                  ? "bg-primary"
                  : "border border-dashed border-destructive/60 bg-transparent",
              )}
            />
          ))}
          <span className="ml-2 text-[11px] text-muted-foreground">tracejado = mês sem compra</span>
        </div>
      </Panel>

      <div className="grid gap-6 2xl:grid-cols-2">
        <Panel
          title="Produtos do cliente (período)"
          actions={
            <ExportMenu
              rows={data.products}
              name={exportName("cliente-produtos", resolved)}
              columns={[
                { header: "SKU", value: (r) => r.sku },
                { header: "Produto", value: (r) => r.name },
                { header: "Categoria", value: (r) => r.category },
                { header: "Quantidade", value: (r) => r.units },
                { header: "Faturamento", value: (r) => r.revenue },
                { header: "Última compra no período", value: (r) => r.lastDate },
                { header: "Última compra histórica", value: (r) => r.lastDateAll },
                { header: "Participação", value: (r) => r.share },
              ]}
            />
          }
        >
          <DataTable
            rows={data.products}
            rowKey={(r) => r.id}
            search={(r) => `${r.sku ?? ""} ${r.name} ${r.category}`}
            onRowClick={(r) =>
              navigate({
                to: "/produtos/$productId",
                params: { productId: r.id },
                search: keepSearch,
              })
            }
            pageSize={15}
            columns={[
              {
                key: "sku",
                header: "SKU",
                cell: (r) => <span className="font-mono text-xs">{r.sku ?? "—"}</span>,
              },
              { key: "name", header: "Produto", cell: (r) => r.name, sort: (r) => r.name },
              {
                key: "category",
                header: "Categoria",
                cell: (r) => (
                  <Link
                    to="/vendas"
                    search={withSearch({ category: r.category })}
                    className="hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {r.category}
                  </Link>
                ),
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
                key: "last",
                header: "Últ. no período",
                align: "right",
                cell: (r) => fmtDate(r.lastDate),
                sort: (r) => r.lastDate,
              },
              {
                key: "lastAll",
                header: "Últ. histórica",
                align: "right",
                cell: (r) => fmtDate(r.lastDateAll),
                sort: (r) => r.lastDateAll ?? "",
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
        <Panel title="Notas fiscais (últimas 50)">
          <DataTable
            rows={data.invoices}
            rowKey={(r) => r.id}
            search={(r) => `${r.number} ${r.seller ?? ""}`}
            onRowClick={(r) => setInvoice(r.id)}
            pageSize={15}
            columns={[
              {
                key: "number",
                header: "NF",
                cell: (r) => <span className="font-mono text-xs">{r.number}</span>,
              },
              { key: "date", header: "Data", cell: (r) => fmtDate(r.date), sort: (r) => r.date },
              { key: "seller", header: "Vendedor", cell: (r) => r.seller ?? "Não atribuído" },
              {
                key: "total",
                header: "Total",
                align: "right",
                cell: (r) => formatValue(r.total, "currency"),
                sort: (r) => r.total,
              },
            ]}
          />
        </Panel>
      </div>
      <CustomerFinance company={resolved.company} customer={customerId} />
      <InvoiceDrawer id={invoice} onClose={() => setInvoice(null)} />
    </main>
  );
}
