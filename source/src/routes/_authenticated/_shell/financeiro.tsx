import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useGlobalFilters } from "@/hooks/use-filters";
import { financeSummaryQuery, financeTitlesQuery } from "@/lib/queries";
import { FpKpi } from "@/components/flight-plan/parts";
import { fmtDate, pageHead, PageSkeleton, Panel } from "@/components/entities/shared";
import {
  AgingTable,
  BilledVsReceivedChart,
  FinanceExportMenu,
  TitlesTable,
  titleExportColumns,
} from "@/components/finance/parts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TITLE_STATUSES, TITLE_STATUS_LABELS, type TitleStatus } from "@/domain/finance";
import { exportName } from "@/lib/export";
import { formatValue } from "@/domain/format";
import { Skeleton } from "@/components/ui/skeleton";

const DESC = "Títulos a receber, recebimentos, inadimplência e aging.";

export const Route = createFileRoute("/_authenticated/_shell/financeiro")({
  head: () => pageHead("Financeiro", DESC),
  component: FinancePage,
});

function FinancePage() {
  const { resolved, company } = useGlobalFilters();
  const [status, setStatus] = useState<TitleStatus | "ALL">("ALL");
  const summary = useQuery({ ...financeSummaryQuery(resolved!), enabled: !!resolved });
  const caps = summary.data?.capabilities ?? [];
  const canTitles = caps.includes("finance.view_titles");
  const titles = useQuery({ ...financeTitlesQuery(resolved!), enabled: !!resolved && canTitles });

  if (!resolved) return null;
  if (summary.error)
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
        <p className="mt-2 text-sm text-muted-foreground">{summary.error.message}</p>
      </main>
    );
  if (summary.isPending) return <PageSkeleton />;
  const d = summary.data;
  const k = d.kpis;
  const rows =
    status === "ALL"
      ? (titles.data?.rows ?? [])
      : (titles.data?.rows ?? []).filter((r) => r.status === status);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header>
        <p className="eyebrow">
          {company?.name} · vencimentos de {fmtDate(d.range.start)} a {fmtDate(d.range.end)} ·
          posição em {fmtDate(d.ref)}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Camada analítica de recebíveis. Vencido = vencimento anterior à data de referência com
          saldo. Títulos cancelados ficam fora dos indicadores ({k.cancelledCount} no recorte).
        </p>
      </header>

      <section className="panel grid grid-cols-2 sm:grid-cols-4">
        <FpKpi
          metricKey="accounts_receivable"
          value={k.receivable}
          sub={`${k.receivableCount} títulos`}
        />
        <FpKpi
          metricKey="amount_received"
          value={k.received}
          sub={`${k.receivedCount} liquidações`}
        />
        <FpKpi
          metricKey="amount_open"
          value={k.open}
          sub={k.openCount == null ? "Sem permissão de inadimplência" : `${k.openCount} títulos`}
        />
        <FpKpi
          metricKey="amount_overdue"
          value={k.overdue}
          tone={k.overdue ? "bad" : null}
          sub={
            d.overdueVisible
              ? `${formatValue(k.overdueRate, "percent")} do aberto`
              : "Sem permissão de inadimplência"
          }
        />
        <FpKpi
          metricKey="amount_due_future"
          value={k.dueFuture}
          sub={k.dueFuture == null ? "Sem permissão de inadimplência" : undefined}
        />
        <FpKpi
          metricKey="customers_overdue"
          value={k.customersOverdue}
          sub={d.overdueVisible ? undefined : "Sem permissão"}
        />
        <FpKpi metricKey="average_days_to_receive" value={k.averageDaysToReceive} />
        <FpKpi metricKey="average_delay_days" value={k.averageDelayDays} />
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Faturado × Recebido (12 meses)">
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Faturado = notas válidas por data de competência. Recebido = liquidações por data de
            liquidação. São conceitos diferentes: uma venda faturada hoje pode ser recebida meses
            depois, em parcelas — os valores não precisam coincidir no mês.
          </p>
          <BilledVsReceivedChart data={d.timeline} />
        </Panel>
        <Panel title="Aging do saldo em aberto">
          <AgingTable rows={d.aging} overdueVisible={d.overdueVisible} />
        </Panel>
      </div>

      {canTitles ? (
        <Panel
          title="Títulos"
          actions={
            <>
              <Select value={status} onValueChange={(v) => setStatus(v as TitleStatus | "ALL")}>
                <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Todos os status</SelectItem>
                  {TITLE_STATUSES.filter((s) => d.overdueVisible || s !== "OVERDUE").map((s) => (
                    <SelectItem key={s} value={s}>
                      {TITLE_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FinanceExportMenu
                company={resolved.company}
                kind="titulos"
                allowed={caps.includes("finance.export")}
                rows={rows}
                columns={titleExportColumns(true)}
                name={exportName("titulos", resolved)}
              />
            </>
          }
        >
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Títulos com saldo em aberto, ou com vencimento, emissão ou liquidação no período.
          </p>
          {titles.error ? (
            <p className="p-4 text-sm text-muted-foreground">{titles.error.message}</p>
          ) : titles.isPending ? (
            <Skeleton className="m-4 h-60" />
          ) : (
            <TitlesTable rows={rows} withCustomer overdueVisible={d.overdueVisible} />
          )}
        </Panel>
      ) : (
        <p className="text-sm text-muted-foreground">
          A lista de títulos exige a permissão &quot;Títulos&quot;.
        </p>
      )}
    </main>
  );
}
