import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatDelta, formatValue } from "@/domain/format";
import type { AnalyticsQuery } from "@/domain/filters";
import { salesBreakdownQuery } from "@/lib/queries";
import type { BreakdownRow, Dimension } from "@/lib/repositories/sales.repository.server";
import { DataTable, type Column } from "@/components/analytics/DataTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { exportName } from "@/lib/export";
import { cn } from "@/lib/utils";

export const DIM_LABELS: Record<Dimension, string> = {
  seller: "Vendedor",
  customer: "Cliente",
  product: "Produto",
  category: "Categoria",
  state: "Estado",
  city: "Cidade",
};

export function breakdownColumns(
  dim: Dimension,
  opts?: { lastDate?: boolean },
): Column<BreakdownRow>[] {
  const cols: Column<BreakdownRow>[] = [
    {
      key: "label",
      header: DIM_LABELS[dim],
      cell: (r) => (
        <div className="max-w-[260px] truncate">
          <span className="font-medium">{r.label ?? "Não atribuído"}</span>
          {r.sub && <span className="ml-2 text-xs text-muted-foreground">{r.sub}</span>}
        </div>
      ),
      sort: (r) => r.label ?? "",
    },
  ];
  if (dim === "product")
    cols.push({
      key: "category",
      header: "Categoria",
      cell: (r) => r.category,
      sort: (r) => r.category,
    });
  cols.push(
    {
      key: "revenue",
      header: "Faturamento",
      align: "right",
      cell: (r) => formatValue(r.revenue, "currency"),
      sort: (r) => r.revenue,
    },
    {
      key: "share",
      header: "Part.",
      align: "right",
      cell: (r) => formatValue(r.share, "percent"),
      sort: (r) => r.share,
    },
    {
      key: "variation",
      header: "Var. mês ant.",
      align: "right",
      cell: (r) => (
        <span
          className={cn(
            r.variation != null && (r.variation >= 0 ? "text-success" : "text-destructive"),
          )}
        >
          {formatDelta(r.variation)}
        </span>
      ),
      sort: (r) => r.variation,
    },
    {
      key: "units",
      header: "Qtd.",
      align: "right",
      cell: (r) => formatValue(r.units, "integer"),
      sort: (r) => r.units,
    },
    {
      key: "invoices",
      header: "NFs",
      align: "right",
      cell: (r) => formatValue(r.invoices, "integer"),
      sort: (r) => r.invoices,
    },
  );
  if (dim !== "product" && dim !== "category")
    cols.push({
      key: "ticket",
      header: "Ticket",
      align: "right",
      cell: (r) => formatValue(r.ticket, "currency"),
      sort: (r) => r.ticket,
    });
  if (opts?.lastDate)
    cols.push({
      key: "lastDate",
      header: "Última compra",
      align: "right",
      cell: (r) => (r.lastDate ? r.lastDate.split("-").reverse().join("/") : "—"),
      sort: (r) => r.lastDate,
    });
  return cols;
}

export const breakdownExport = (dim: Dimension) => [
  { header: DIM_LABELS[dim], value: (r: BreakdownRow) => r.label },
  { header: "Detalhe", value: (r: BreakdownRow) => r.sub },
  { header: "Categoria", value: (r: BreakdownRow) => r.category },
  { header: "Faturamento", value: (r: BreakdownRow) => r.revenue },
  { header: "Participação", value: (r: BreakdownRow) => r.share },
  { header: "Faturamento mês anterior", value: (r: BreakdownRow) => r.previous },
  { header: "Variação", value: (r: BreakdownRow) => r.variation },
  { header: "Quantidade", value: (r: BreakdownRow) => r.units },
  { header: "NFs", value: (r: BreakdownRow) => r.invoices },
  { header: "Ticket", value: (r: BreakdownRow) => r.ticket },
];

export function SalesDrivers({
  q,
  dim,
  onDim,
}: {
  q: AnalyticsQuery;
  dim: Dimension;
  onDim: (d: Dimension) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data, isPending, error } = useQuery(salesBreakdownQuery(q, dim));
  const rows = data?.rows ?? [];
  return (
    <section className="panel">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Drivers do resultado</h2>
        <Tabs
          className="min-w-0 max-w-full"
          value={dim}
          onValueChange={(v) => onDim(v as Dimension)}
        >
          <TabsList className="h-8 max-w-full justify-start overflow-x-auto">
            {(Object.keys(DIM_LABELS) as Dimension[]).map((d) => (
              <TabsTrigger key={d} value={d} className="text-xs">
                Por {DIM_LABELS[d]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="ml-auto">
          <ExportMenu
            rows={rows}
            columns={breakdownExport(dim)}
            name={exportName(`vendas-por-${dim}`, q)}
          />
        </div>
      </div>
      {error ? (
        <p className="p-6 text-sm text-muted-foreground">{error.message}</p>
      ) : isPending ? (
        <Skeleton className="m-4 h-48" />
      ) : (
        <>
          <DataTable
            rows={expanded ? rows : rows.slice(0, 10)}
            columns={breakdownColumns(dim)}
            rowKey={(r, i) => r.key ?? `none-${i}`}
            {...(expanded ? { search: (r: BreakdownRow) => `${r.label} ${r.sub ?? ""}` } : {})}
            pageSize={200}
          />
          {rows.length > 10 && (
            <div className="border-t p-2 text-center">
              <Button size="sm" variant="ghost" onClick={() => setExpanded((e) => !e)}>
                {expanded ? "Mostrar top 10" : `Ver tabela completa (${rows.length})`}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
