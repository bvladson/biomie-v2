import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatValue } from "@/domain/format";
import type { AnalyticsQuery } from "@/domain/filters";
import { invoicesQuery, itemsQuery, ordersQuery } from "@/lib/queries";
import { fetchInvoiceDetail } from "@/lib/sales.functions";
import type { InvoiceRow, ItemRow, OrderRow } from "@/lib/repositories/sales.repository.server";
import { DataTable, type Column } from "@/components/analytics/DataTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { exportName } from "@/lib/export";

const br = (iso: string | null | undefined) => (iso ? iso.split("-").reverse().join("/") : "—");
const brl = (v: number | null) => formatValue(v, "currency");
const STATUS: Record<string, string> = {
  authorized: "Autorizada",
  cancelled: "Cancelada",
  denied: "Denegada",
  open: "Em aberto",
  invoiced: "Faturado",
};
const BUCKET: Record<string, string> = {
  fresh: "0–15 dias",
  recent: "16–45 dias",
  aged: "> 45 dias",
};

function Loading({ error, pending }: { error: Error | null; pending: boolean }) {
  if (error) return <p className="p-6 text-sm text-muted-foreground">{error.message}</p>;
  if (pending) return <Skeleton className="m-4 h-64" />;
  return null;
}

// ---------- Invoices ----------

const invoiceCols: Column<InvoiceRow>[] = [
  {
    key: "number",
    header: "Número",
    cell: (r) => <span className="font-mono text-xs">{r.number}</span>,
    sort: (r) => r.number,
  },
  { key: "date", header: "Data", cell: (r) => br(r.date), sort: (r) => r.date },
  {
    key: "competence",
    header: "Competência",
    cell: (r) => r.competence.split("-").reverse().join("/"),
    sort: (r) => r.competence,
  },
  {
    key: "customer",
    header: "Cliente",
    cell: (r) => <span className="block max-w-[200px] truncate">{r.customer}</span>,
    sort: (r) => r.customer,
  },
  { key: "seller", header: "Vendedor", cell: (r) => r.seller ?? "—", sort: (r) => r.seller },
  { key: "city", header: "Cidade", cell: (r) => r.city, sort: (r) => r.city },
  { key: "state", header: "UF", cell: (r) => r.state, sort: (r) => r.state },
  {
    key: "total",
    header: "Valor",
    align: "right",
    cell: (r) => brl(r.total),
    sort: (r) => r.total,
  },
  {
    key: "status",
    header: "Status fiscal",
    cell: (r) => (
      <Badge variant={r.counted ? "secondary" : "outline"} className="text-[11px]">
        {STATUS[r.status]}
        {!r.counted && " · fora do faturamento"}
      </Badge>
    ),
    sort: (r) => r.status,
  },
  { key: "items", header: "Itens", align: "right", cell: (r) => r.items, sort: (r) => r.items },
];

const invoiceExport = [
  { header: "Número", value: (r: InvoiceRow) => r.number },
  { header: "Data", value: (r: InvoiceRow) => r.date },
  { header: "Competência", value: (r: InvoiceRow) => r.competence },
  { header: "Cliente", value: (r: InvoiceRow) => r.customer },
  { header: "Vendedor", value: (r: InvoiceRow) => r.seller },
  { header: "Cidade", value: (r: InvoiceRow) => r.city },
  { header: "UF", value: (r: InvoiceRow) => r.state },
  { header: "Valor", value: (r: InvoiceRow) => r.total },
  { header: "Status fiscal", value: (r: InvoiceRow) => STATUS[r.status] },
  { header: "Conta no faturamento", value: (r: InvoiceRow) => (r.counted ? "Sim" : "Não") },
  { header: "Itens", value: (r: InvoiceRow) => r.items },
];

export function InvoicesTab({ q }: { q: AnalyticsQuery }) {
  const { data, isPending, error } = useQuery(invoicesQuery(q));
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <Loading error={error} pending={isPending} />;
  const rows = status === "all" ? data : data.filter((r) => r.status === status);
  return (
    <>
      <DataTable
        rows={rows}
        columns={invoiceCols}
        rowKey={(r) => r.id}
        search={(r) => `${r.number} ${r.customer} ${r.seller ?? ""} ${r.city}`}
        onRowClick={(r) => setOpen(r.id)}
        initialSort={{ key: "date", dir: "desc" }}
        toolbar={
          <>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-8 w-40" aria-label="Status fiscal">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os status</SelectItem>
                <SelectItem value="authorized">Autorizadas</SelectItem>
                <SelectItem value="cancelled">Canceladas</SelectItem>
                <SelectItem value="denied">Denegadas</SelectItem>
              </SelectContent>
            </Select>
            <ExportMenu rows={rows} columns={invoiceExport} name={exportName("notas", q)} />
          </>
        }
      />
      <InvoiceDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function InvoiceDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const fetchDetail = useServerFn(fetchInvoiceDetail);
  const { data, isPending, error } = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => fetchDetail({ data: { id: id! } }),
    enabled: !!id,
  });
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {error ? (
          <p className="p-6 text-sm text-muted-foreground">{error.message}</p>
        ) : isPending || !data ? (
          <Skeleton className="m-6 h-64" />
        ) : (
          <div className="flex flex-col gap-5">
            <SheetHeader>
              <SheetTitle>NF {data.number}</SheetTitle>
              <SheetDescription>
                {br(data.date)} · {STATUS[data.status]}
              </SheetDescription>
            </SheetHeader>
            <dl className="grid grid-cols-2 gap-3 px-4 text-sm">
              <div>
                <dt className="eyebrow">Cliente</dt>
                <dd>{data.customer?.name}</dd>
                <dd className="text-xs text-muted-foreground">
                  {data.customer?.city}/{data.customer?.state}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Vendedor</dt>
                <dd>{data.seller ?? "—"}</dd>
                <dd className="text-xs text-muted-foreground">
                  {[data.channel, data.branch].filter(Boolean).join(" · ")}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Valor total</dt>
                <dd className="text-lg font-semibold tabular">{brl(data.total)}</dd>
              </div>
              <div>
                <dt className="eyebrow">Itens</dt>
                <dd>{data.items.length}</dd>
              </div>
            </dl>
            <div className="mx-4 rounded-md border">
              <DataTable
                rows={data.items}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: "sku",
                    header: "SKU",
                    cell: (r) => <span className="font-mono text-xs">{r.sku}</span>,
                  },
                  { key: "product", header: "Produto", cell: (r) => r.product },
                  { key: "category", header: "Categoria", cell: (r) => r.category },
                  {
                    key: "qty",
                    header: "Qtd.",
                    align: "right",
                    cell: (r) => formatValue(r.qty, "integer"),
                  },
                  {
                    key: "unit",
                    header: "Preço unit.",
                    align: "right",
                    cell: (r) => brl(r.unitPrice),
                  },
                  { key: "total", header: "Total", align: "right", cell: (r) => brl(r.total) },
                ]}
              />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------- Orders ----------

const pct = (v: number) => `${Math.round(v * 100)}%`;
const orderCols: Column<OrderRow>[] = [
  {
    key: "number",
    header: "Pedido",
    cell: (r) => <span className="font-mono text-xs">{r.number}</span>,
    sort: (r) => r.number,
  },
  { key: "date", header: "Data", cell: (r) => br(r.date), sort: (r) => r.date },
  {
    key: "customer",
    header: "Cliente",
    cell: (r) => <span className="block max-w-[200px] truncate">{r.customer}</span>,
    sort: (r) => r.customer,
  },
  { key: "seller", header: "Vendedor", cell: (r) => r.seller ?? "—", sort: (r) => r.seller },
  {
    key: "status",
    header: "Status",
    cell: (r) => STATUS[r.status] ?? r.status,
    sort: (r) => r.status,
  },
  {
    key: "total",
    header: "Valor",
    align: "right",
    cell: (r) => brl(r.total),
    sort: (r) => r.total,
  },
  {
    key: "age",
    header: "Idade",
    align: "right",
    cell: (r) => formatValue(r.ageDays, "days"),
    sort: (r) => r.ageDays,
  },
  {
    key: "expected",
    header: "Previsão",
    cell: (r) => br(r.expectedDate),
    sort: (r) => r.expectedDate,
  },
  { key: "items", header: "Itens", align: "right", cell: (r) => r.items, sort: (r) => r.items },
  {
    key: "participation",
    header: "Participa de",
    cell: (r) =>
      r.weight ? (
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary" className="text-[10px]">
            Carteira 100%
          </Badge>
          <Badge
            variant={r.weight.inForecastBase ? "secondary" : "outline"}
            className="text-[10px]"
          >
            Base {r.weight.inForecastBase ? "100%" : "—"}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            Provável {pct(r.weight.weight)}
          </Badge>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Não participa</span>
      ),
    sort: (r) => r.weight?.weight ?? -1,
  },
  {
    key: "weighted",
    header: "Valor ponderado",
    align: "right",
    cell: (r) => brl(r.weight?.weighted ?? null),
    sort: (r) => r.weight?.weighted ?? 0,
  },
];

const orderExport = [
  { header: "Pedido", value: (r: OrderRow) => r.number },
  { header: "Data", value: (r: OrderRow) => r.date },
  { header: "Cliente", value: (r: OrderRow) => r.customer },
  { header: "Vendedor", value: (r: OrderRow) => r.seller },
  { header: "Status", value: (r: OrderRow) => STATUS[r.status] ?? r.status },
  { header: "Valor", value: (r: OrderRow) => r.total },
  { header: "Idade (dias)", value: (r: OrderRow) => r.ageDays },
  { header: "Previsão", value: (r: OrderRow) => r.expectedDate },
  { header: "Itens", value: (r: OrderRow) => r.items },
  { header: "Faixa", value: (r: OrderRow) => (r.weight ? BUCKET[r.weight.bucket] : null) },
  { header: "Forecast Base", value: (r: OrderRow) => (r.weight?.inForecastBase ? "Sim" : "Não") },
  { header: "Peso Forecast Provável", value: (r: OrderRow) => r.weight?.weight ?? null },
  { header: "Valor ponderado", value: (r: OrderRow) => r.weight?.weighted ?? null },
];

export function OrdersTab({ q }: { q: AnalyticsQuery }) {
  const { data, isPending, error } = useQuery(ordersQuery(q));
  if (!data) return <Loading error={error} pending={isPending} />;
  const open = data.rows.filter((r) => r.status === "open");
  const total = open.reduce((a, r) => a + r.total, 0);
  const weighted = open.reduce((a, r) => a + (r.weight?.weighted ?? 0), 0);
  const base = open.filter((r) => r.weight?.inForecastBase).reduce((a, r) => a + r.total, 0);
  const w = data.config.probableWeights;
  const b = data.config.ageBuckets;
  return (
    <>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-b px-4 py-3 text-xs text-muted-foreground">
        <span>
          Carteira: <b className="text-foreground tabular">{brl(total)}</b>
        </span>
        <span>
          Entra no Forecast Base: <b className="text-foreground tabular">{brl(base)}</b>
        </span>
        <span>
          Carteira ponderada (Forecast Provável):{" "}
          <b className="text-foreground tabular">{brl(weighted)}</b>
        </span>
        <span className="w-full">
          REGRA PROVISÓRIA DO MODO DEMONSTRAÇÃO: 0–{b.freshMaxDays} dias → {pct(w.fresh)} ·{" "}
          {b.freshMaxDays + 1}–{b.recentMaxDays} dias → {pct(w.recent)} · acima de {b.recentMaxDays}{" "}
          dias → {pct(w.aged)}. Base considera só pedidos até {b.freshMaxDays} dias.
        </span>
      </div>
      <DataTable
        rows={data.rows}
        columns={orderCols}
        rowKey={(r) => r.id}
        search={(r) => `${r.number} ${r.customer} ${r.seller ?? ""}`}
        initialSort={{ key: "date", dir: "desc" }}
        toolbar={
          <ExportMenu rows={data.rows} columns={orderExport} name={exportName("pedidos", q)} />
        }
      />
    </>
  );
}

// ---------- Items ----------

const itemCols: Column<ItemRow>[] = [
  {
    key: "invoice",
    header: "NF",
    cell: (r) => <span className="font-mono text-xs">{r.invoice}</span>,
    sort: (r) => r.invoice,
  },
  { key: "date", header: "Data", cell: (r) => br(r.date), sort: (r) => r.date },
  {
    key: "sku",
    header: "SKU",
    cell: (r) => <span className="font-mono text-xs">{r.sku}</span>,
    sort: (r) => r.sku,
  },
  { key: "product", header: "Produto", cell: (r) => r.product, sort: (r) => r.product },
  { key: "category", header: "Categoria", cell: (r) => r.category, sort: (r) => r.category },
  {
    key: "qty",
    header: "Qtd.",
    align: "right",
    cell: (r) => formatValue(r.qty, "integer"),
    sort: (r) => r.qty,
  },
  {
    key: "unit",
    header: "Preço unit.",
    align: "right",
    cell: (r) => brl(r.unitPrice),
    sort: (r) => r.unitPrice,
  },
  {
    key: "total",
    header: "Valor total",
    align: "right",
    cell: (r) => brl(r.total),
    sort: (r) => r.total,
  },
  {
    key: "customer",
    header: "Cliente",
    cell: (r) => <span className="block max-w-[180px] truncate">{r.customer}</span>,
    sort: (r) => r.customer,
  },
  { key: "seller", header: "Vendedor", cell: (r) => r.seller ?? "—", sort: (r) => r.seller },
];

const itemExport = [
  { header: "NF", value: (r: ItemRow) => r.invoice },
  { header: "Data", value: (r: ItemRow) => r.date },
  { header: "SKU", value: (r: ItemRow) => r.sku },
  { header: "Produto", value: (r: ItemRow) => r.product },
  { header: "Categoria", value: (r: ItemRow) => r.category },
  { header: "Quantidade", value: (r: ItemRow) => r.qty },
  { header: "Preço unitário", value: (r: ItemRow) => r.unitPrice },
  { header: "Valor total", value: (r: ItemRow) => r.total },
  { header: "Cliente", value: (r: ItemRow) => r.customer },
  { header: "Vendedor", value: (r: ItemRow) => r.seller },
];

export function ItemsTab({ q }: { q: AnalyticsQuery }) {
  const { data, isPending, error } = useQuery(itemsQuery(q));
  if (!data) return <Loading error={error} pending={isPending} />;
  return (
    <DataTable
      rows={data}
      columns={itemCols}
      rowKey={(r, i) => `${r.invoiceId}-${i}`}
      search={(r) => `${r.invoice} ${r.sku} ${r.product} ${r.customer} ${r.seller ?? ""}`}
      initialSort={{ key: "date", dir: "desc" }}
      toolbar={<ExportMenu rows={data} columns={itemExport} name={exportName("itens", q)} />}
    />
  );
}
