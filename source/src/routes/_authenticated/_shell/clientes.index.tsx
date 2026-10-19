import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useGlobalFilters } from "@/hooks/use-filters";
import { customersQuery } from "@/lib/queries";
import { formatValue, maskDocument } from "@/domain/format";
import { FpKpi } from "@/components/flight-plan/parts";
import { DataTable, type Column } from "@/components/analytics/DataTable";
import { ExportMenu } from "@/components/analytics/ExportMenu";
import { exportName } from "@/lib/export";
import type { CustomerRow } from "@/lib/repositories/customers-products.repository.server";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  fmtDate,
  keepSearch,
  pageHead,
  PageSkeleton,
  Panel,
  UNASSIGNED,
} from "@/components/entities/shared";

const DESC = "Clientes ativos, novos, recorrentes, recência e participação no faturamento.";

export const Route = createFileRoute("/_authenticated/_shell/clientes/")({
  head: () => pageHead("Clientes", DESC),
  component: CustomersPage,
});

const INACTIVE_OPTIONS = [30, 60, 90, 180, 365];

function CustomersPage() {
  const { resolved } = useGlobalFilters();
  const navigate = useNavigate();
  const [inactiveDays, setInactiveDays] = useState(90);
  const [onlyActive, setOnlyActive] = useState(true);
  const { data, isPending, error } = useQuery({
    ...customersQuery(resolved!, inactiveDays),
    enabled: !!resolved,
  });
  if (!resolved) return null;
  if (error) return <p className="p-8 text-sm text-muted-foreground">{error.message}</p>;
  if (isPending || !data) return <PageSkeleton />;

  const s = data.summary;
  const rows = onlyActive ? data.rows.filter((r) => r.revenue > 0) : data.rows;
  const columns: Column<CustomerRow>[] = [
    {
      key: "name",
      header: "Cliente",
      cell: (r) => <span className="font-medium">{r.name}</span>,
      sort: (r) => r.name,
    },
    {
      key: "doc",
      header: "CPF/CNPJ",
      cell: (r) => <span className="font-mono text-xs">{maskDocument(r.document)}</span>,
    },
    { key: "city", header: "Cidade", cell: (r) => r.city, sort: (r) => r.city },
    { key: "state", header: "UF", cell: (r) => r.state, sort: (r) => r.state },
    {
      key: "seller",
      header: "Vendedor principal",
      cell: (r) =>
        r.sellerId ? (
          <Link
            to="/vendedores/$sellerId"
            params={{ sellerId: r.sellerId }}
            search={keepSearch}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {r.seller}
          </Link>
        ) : (
          UNASSIGNED
        ),
      sort: (r) => r.seller ?? "",
    },
    {
      key: "first",
      header: "Primeira compra",
      cell: (r) => fmtDate(r.firstDate),
      sort: (r) => r.firstDate,
    },
    {
      key: "last",
      header: "Última compra",
      cell: (r) => fmtDate(r.lastDate),
      sort: (r) => r.lastDate,
    },
    {
      key: "days",
      header: "Dias s/ comprar",
      align: "right",
      cell: (r) => (
        <span className={r.daysSince > inactiveDays ? "text-destructive" : undefined}>
          {r.daysSince}
        </span>
      ),
      sort: (r) => r.daysSince,
    },
    {
      key: "purchases",
      header: "Compras",
      align: "right",
      cell: (r) => r.purchases,
      sort: (r) => r.purchases,
    },
    {
      key: "revenue",
      header: "Faturamento",
      align: "right",
      cell: (r) => formatValue(r.revenue, "currency"),
      sort: (r) => r.revenue,
    },
    {
      key: "ticket",
      header: "Ticket",
      align: "right",
      cell: (r) => formatValue(r.ticket, "currency"),
      sort: (r) => r.ticket,
    },
    {
      key: "share",
      header: "Part.",
      align: "right",
      cell: (r) => formatValue(r.share, "percent"),
      sort: (r) => r.share,
    },
  ];

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header>
        <p className="eyebrow">
          {fmtDate(data.range.start)} a {fmtDate(data.range.end)} · referência {fmtDate(data.asOf)}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
      </header>
      <section className="panel grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7">
        <FpKpi metricKey="active_customers" value={s.active} />
        <FpKpi metricKey="new_customers" value={s.new} />
        <FpKpi metricKey="recurring_customers" value={s.recurring} />
        <FpKpi metricKey="revenue" value={s.revenue} />
        <FpKpi metricKey="average_ticket" value={s.ticket} />
        <FpKpi
          metricKey="customer_frequency"
          label="Frequência média"
          value={s.frequency}
          format="integer"
          sub="NFs por cliente ativo"
        />
        <FpKpi
          metricKey="inactive_customers"
          label={`Sem comprar > ${s.inactiveDays}d`}
          value={s.inactive}
        />
      </section>
      {s.unassignedRevenue > 0 && (
        <p className="text-xs text-warning">
          {UNASSIGNED}: {formatValue(s.unassignedRevenue, "currency")} sem cliente identificado.
        </p>
      )}
      <Panel
        title="Clientes"
        actions={
          <>
            <div className="flex items-center gap-2">
              <Switch id="only-active" checked={onlyActive} onCheckedChange={setOnlyActive} />
              <Label htmlFor="only-active" className="text-xs">
                Só com compra no período
              </Label>
            </div>
            <Select value={String(inactiveDays)} onValueChange={(v) => setInactiveDays(Number(v))}>
              <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Dias sem comprar">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INACTIVE_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    Inativo após {d} dias
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ExportMenu
              rows={rows}
              name={exportName("clientes", resolved)}
              columns={[
                { header: "Cliente", value: (r) => r.name },
                { header: "CPF/CNPJ", value: (r) => maskDocument(r.document) },
                { header: "Cidade", value: (r) => r.city },
                { header: "UF", value: (r) => r.state },
                { header: "Vendedor principal", value: (r) => r.seller ?? UNASSIGNED },
                { header: "Primeira compra", value: (r) => r.firstDate },
                { header: "Última compra", value: (r) => r.lastDate },
                { header: "Dias desde última compra", value: (r) => r.daysSince },
                { header: "Compras", value: (r) => r.purchases },
                { header: "Faturamento", value: (r) => r.revenue },
                { header: "Ticket médio", value: (r) => r.ticket },
                { header: "Participação", value: (r) => r.share },
              ]}
            />
          </>
        }
      >
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          search={(r) => `${r.name} ${r.city} ${r.state} ${r.seller ?? ""}`}
          onRowClick={(r) =>
            navigate({
              to: "/clientes/$customerId",
              params: { customerId: r.id },
              search: keepSearch,
            })
          }
          initialSort={{ key: "revenue", dir: "desc" }}
          pageSize={50}
        />
      </Panel>
    </main>
  );
}
