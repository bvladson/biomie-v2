import { useQuery } from "@tanstack/react-query";
import { FpKpi } from "@/components/flight-plan/parts";
import { DataTable } from "@/components/analytics/DataTable";
import { fmtDate, Panel } from "@/components/entities/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { formatValue } from "@/domain/format";
import { customerFinanceQuery, financeCapabilitiesQuery } from "@/lib/queries";
import {
  AgingTable,
  FinanceExportMenu,
  TitlesTable,
  titleExportColumns,
} from "@/components/finance/parts";

/** Financeiro section of Cliente 360 — gated server-side by finance.view_customer_details. */
export function CustomerFinance({ company, customer }: { company: string; customer: string }) {
  const caps = useQuery(financeCapabilitiesQuery());
  const allowed = caps.data?.includes("finance.view_customer_details") ?? false;
  const { data, isPending, error } = useQuery({
    ...customerFinanceQuery(company, customer),
    enabled: allowed,
  });
  if (caps.isPending) return <Skeleton className="h-40" />;
  if (!allowed)
    return (
      <Panel title="Financeiro">
        <p className="p-4 text-sm text-muted-foreground">
          Seu perfil não tem a permissão &quot;Financeiro do cliente&quot;.
        </p>
      </Panel>
    );
  if (error)
    return (
      <Panel title="Financeiro">
        <p className="p-4 text-sm text-muted-foreground">{error.message}</p>
      </Panel>
    );
  if (isPending) return <Skeleton className="h-60" />;

  return (
    <Panel
      title={`Financeiro · posição em ${fmtDate(data.ref)}`}
      actions={
        <FinanceExportMenu
          company={company}
          kind="titulos-cliente"
          allowed={caps.data?.includes("finance.export") ?? false}
          rows={data.titles}
          columns={titleExportColumns(false)}
          name={`biomie_titulos_cliente_${data.ref}`}
        />
      }
    >
      <div className="grid grid-cols-2 border-b sm:grid-cols-5">
        <FpKpi metricKey="revenue" label="Total faturado" value={data.billed} sub="Histórico" />
        <FpKpi metricKey="amount_received" label="Recebido" value={data.received} sub="Histórico" />
        <FpKpi metricKey="amount_open" value={data.open} />
        <FpKpi
          metricKey="amount_overdue"
          value={data.overdue}
          tone={data.overdue ? "bad" : null}
          sub={data.overdueVisible ? undefined : "Sem permissão"}
        />
        <FpKpi
          metricKey="accounts_receivable"
          label="Total em títulos"
          value={data.titled}
          sub="Não cancelados"
        />
      </div>
      <div className="grid gap-0 xl:grid-cols-2">
        <div className="border-b xl:border-r">
          <h3 className="px-4 pt-3 text-xs font-semibold text-muted-foreground">
            Aging individual
          </h3>
          <AgingTable rows={data.aging} overdueVisible={data.overdueVisible} />
        </div>
        <div className="border-b">
          <h3 className="px-4 pt-3 text-xs font-semibold text-muted-foreground">
            Histórico de recebimentos
          </h3>
          <DataTable
            rows={data.settlements}
            rowKey={(r, i) => `${r.document}-${r.installment}-${r.date}-${i}`}
            pageSize={10}
            columns={[
              {
                key: "date",
                header: "Liquidação",
                cell: (r) => fmtDate(r.date),
                sort: (r) => r.date,
              },
              { key: "doc", header: "Documento", cell: (r) => `${r.document} · ${r.installment}` },
              { key: "due", header: "Vencimento", cell: (r) => fmtDate(r.dueDate) },
              ...(data.overdueVisible
                ? [
                    {
                      key: "late",
                      header: "Atraso",
                      align: "right" as const,
                      cell: (r: (typeof data.settlements)[number]) =>
                        formatValue(r.daysLate, "days"),
                      sort: (r: (typeof data.settlements)[number]) => r.daysLate,
                    },
                  ]
                : []),
              {
                key: "amount",
                header: "Valor",
                align: "right",
                cell: (r) => formatValue(r.amount, "currency"),
                sort: (r) => r.amount,
              },
            ]}
          />
        </div>
      </div>
      <TitlesTable rows={data.titles} withCustomer={false} overdueVisible={data.overdueVisible} />
    </Panel>
  );
}
