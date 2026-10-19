import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useGlobalFilters } from "@/hooks/use-filters";
import { productsQuery } from "@/lib/queries";
import { formatValue } from "@/domain/format";
import { QUICK_WINDOW_LABELS, type QuickWindow } from "@/domain/comparison";
import { FpKpi } from "@/components/flight-plan/parts";
import { DataTable } from "@/components/analytics/DataTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { Button } from "@/components/ui/button";
import { exportName } from "@/lib/export";
import {
  fmtDate,
  keepSearch,
  pageHead,
  PageSkeleton,
  Panel,
  withSearch,
} from "@/components/entities/shared";

export const Route = createFileRoute("/_authenticated/_shell/produtos/")({
  head: () =>
    pageHead(
      "Produtos",
      "Faturamento, quantidade, preço médio, clientes e vendedores por produto.",
    ),
  component: ProductsPage,
});

function ProductsPage() {
  const { resolved } = useGlobalFilters();
  const navigate = useNavigate();
  const [win, setWin] = useState<QuickWindow | undefined>();
  // The global period has priority: changing it clears the quick window.
  const period = resolved?.period;
  useEffect(() => setWin(undefined), [period]);
  const { data, isPending, error } = useQuery({
    ...productsQuery(resolved!, win),
    enabled: !!resolved,
  });
  if (!resolved) return null;
  if (error) return <p className="p-8 text-sm text-muted-foreground">{error.message}</p>;
  if (isPending || !data) return <PageSkeleton />;
  const s = data.summary;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <p className="eyebrow">
            {fmtDate(data.range.start)} a {fmtDate(data.range.end)}
            {data.window
              ? ` · período rápido ${QUICK_WINDOW_LABELS[data.window]}`
              : " · período global"}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Produtos</h1>
        </div>
        <div
          className="ml-auto flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Períodos rápidos"
        >
          {(Object.keys(QUICK_WINDOW_LABELS) as QuickWindow[]).map((w) => (
            <Button
              key={w}
              size="sm"
              variant={win === w ? "default" : "outline"}
              onClick={() => setWin(w)}
            >
              {QUICK_WINDOW_LABELS[w]}
            </Button>
          ))}
          {win && (
            <Button size="sm" variant="ghost" onClick={() => setWin(undefined)}>
              <X className="size-3.5" /> Usar período global
            </Button>
          )}
        </div>
      </header>
      <section className="panel grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <FpKpi
          metricKey="product_revenue"
          label="Produtos vendidos"
          value={s.products}
          format="integer"
        />
        <FpKpi metricKey="units" value={s.units} />
        <FpKpi metricKey="revenue" value={s.revenue} />
        <FpKpi metricKey="avg_unit_price" value={s.avgPrice} />
        <FpKpi metricKey="customers" value={s.customers} />
        <FpKpi
          metricKey="product_revenue"
          label="Categorias"
          value={s.categories}
          format="integer"
        />
      </section>
      <Panel
        title="Produtos"
        actions={
          <ExportMenu
            rows={data.rows}
            name={exportName(`produtos${data.window ? `-${data.window}` : ""}`, resolved)}
            columns={[
              { header: "SKU", value: (r) => r.sku },
              { header: "Produto", value: (r) => r.name },
              { header: "Categoria", value: (r) => r.category },
              { header: "Quantidade", value: (r) => r.units },
              { header: "Faturamento", value: (r) => r.revenue },
              { header: "Preço médio", value: (r) => r.avgPrice },
              { header: "Clientes", value: (r) => r.customers },
              { header: "Vendedores", value: (r) => r.sellers },
              { header: "Última venda", value: (r) => r.lastDate },
              { header: "Participação", value: (r) => r.share },
            ]}
          />
        }
      >
        <DataTable
          rows={data.rows}
          rowKey={(r) => r.id}
          search={(r) => `${r.sku ?? ""} ${r.name} ${r.category}`}
          onRowClick={(r) =>
            navigate({
              to: "/produtos/$productId",
              params: { productId: r.id },
              search: keepSearch,
            })
          }
          initialSort={{ key: "revenue", dir: "desc" }}
          pageSize={50}
          columns={[
            {
              key: "sku",
              header: "SKU",
              cell: (r) => <span className="font-mono text-xs">{r.sku ?? "—"}</span>,
              sort: (r) => r.sku,
            },
            {
              key: "name",
              header: "Produto",
              cell: (r) => <span className="font-medium">{r.name}</span>,
              sort: (r) => r.name,
            },
            {
              key: "category",
              header: "Categoria",
              cell: (r) => (
                <Link
                  to="/vendas"
                  search={withSearch({ category: r.category })}
                  className="hover:underline"
                  title="Abrir análise da categoria em Vendas"
                  onClick={(e) => e.stopPropagation()}
                >
                  {r.category}
                </Link>
              ),
              sort: (r) => r.category,
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
              key: "customers",
              header: "Clientes",
              align: "right",
              cell: (r) => r.customers,
              sort: (r) => r.customers,
            },
            {
              key: "sellers",
              header: "Vendedores",
              align: "right",
              cell: (r) => r.sellers,
              sort: (r) => r.sellers,
            },
            {
              key: "last",
              header: "Última venda",
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
    </main>
  );
}
