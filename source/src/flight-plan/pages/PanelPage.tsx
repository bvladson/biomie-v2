import { Download } from "lucide-react";
import type { Comparison, SellerRow } from "../api/contract";
import { brl0, dateBr, num, pct } from "../lib/format";
import { STATUS_META } from "@/domain/flight-plan/config";
import { exportCsv as exportTable, type ExportColumn } from "@/lib/export";
import { useFilters, usePlan } from "../lib/hooks";
import {
  ErrorState,
  InfoTip,
  Loading,
  Panel,
  StatusBadge,
  TableWrap,
  td,
  tdR,
  th,
  thR,
} from "../components/bits";
import type { MetricKey } from "../lib/definitions";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
const RANKING_COLUMNS: ExportColumn<{ r: SellerRow; position: number }>[] = [
  { header: "Posição", value: (x) => x.position },
  { header: "Vendedor", value: (x) => x.r.seller.name },
  { header: "Canal", value: (x) => (x.r.seller.channel === "licitacao" ? "Licitação" : "Varejo") },
  {
    header: "Status",
    value: (x) => (x.r.metrics.status ? STATUS_META[x.r.metrics.status].label : "Sem meta"),
  },
  { header: "Meta", value: (x) => x.r.metrics.target },
  { header: "Realizado", value: (x) => x.r.metrics.realized },
  {
    header: "% meta",
    value: (x) => round2(x.r.metrics.attainment === null ? null : x.r.metrics.attainment * 100),
  },
  { header: "Faturamento/dia útil", value: (x) => x.r.productivity.revenuePerWorkday },
  { header: "Notas/dia útil", value: (x) => x.r.productivity.invoicesPerWorkday },
  { header: "Clientes", value: (x) => x.r.productivity.customers },
  { header: "Ticket médio", value: (x) => x.r.productivity.averageTicket },
];

export function PanelPage() {
  const f = useFilters();
  const plan = usePlan();
  if (plan.isPending) return <Loading />;
  if (plan.isError) return <ErrorState error={plan.error} retry={() => plan.refetch()} />;
  const p = plan.data,
    m = p.summary,
    i = p.indicators,
    c = i.comparison;
  const ranking = p.sellers
    .filter((s) => s.hasActivity)
    .sort(
      (a, b) =>
        (b.metrics.attainment ?? -1) - (a.metrics.attainment ?? -1) ||
        b.metrics.realized - a.metrics.realized,
    );
  // Mesmas linhas da tela, pelo módulo oficial de exportação (protege contra texto que vira fórmula).
  const exportRanking = () =>
    exportTable(
      ranking.map((r, k) => ({ r, position: k + 1 })),
      RANKING_COLUMNS,
      `plano-de-voo-ranking-${f.company.slug}-${f.month}${f.search.canal ? "-" + f.search.canal : ""}`,
    );
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Ind
          label="Faturamento"
          metric="realized"
          value={brl0(m.realized)}
          cmp={c}
          current={m.realized}
        />
        <Ind label="Notas" metric="invoices" value={num(i.invoices)} />
        <Ind label="Ticket médio" metric="ticket" value={brl0(i.averageTicket)} />
        <Ind
          label="Clientes atendidos"
          metric="customers"
          value={num(i.customers)}
          extra={`${i.newCustomers} novos · ${i.recurringCustomers} recorrentes`}
        />
        <Ind
          label="Orçamentos em aberto"
          metric="quotes"
          value={`${i.openQuotes.count} · ${brl0(i.openQuotes.amount)}`}
          extra={`idade média ${i.openQuotes.avgAgeDays ?? "—"} dias · fora da previsão`}
        />
        <Ind
          label="Conversão"
          metric="conversion"
          value={
            i.conversion.status === "forming"
              ? "Em formação"
              : `${pct(i.conversion.rateCount)} · ${pct(i.conversion.rateAmount)} em valor`
          }
          extra={
            i.conversion.status === "forming"
              ? `Conversão em formação desde ${dateBr(i.conversion.since).slice(0, 5)}: o BIOMIE começou a registrar quando um orçamento vira pedido. No lugar: ${i.openQuotes.count} orçamentos em aberto (${brl0(i.openQuotes.amount)}).`
              : `${i.conversion.converted} convertidos de ${i.conversion.quotes}`
          }
        />
        <Ind
          label="Carteira"
          metric="portfolio"
          value={brl0(m.portfolio)}
          extra={`ponderada ${brl0(m.portfolioWeighted)} · atrasados ${brl0(m.lateOrdersAmount)}`}
        />
        <Ind
          label="Previsões"
          metric="forecastProbable"
          value={brl0(m.forecastProbable)}
          extra={`base ${brl0(m.forecastBase)} · ritmo ${brl0(m.runRateForecast)} · comprometida ${brl0(m.forecastCommit)}`}
        />
      </div>
      <Panel
        title={
          <span className="flex items-center gap-1">
            Ranking e produtividade <InfoTip metric="productivity" />
          </span>
        }
        action={
          <Button variant="outline" size="sm" onClick={exportRanking} disabled={!ranking.length}>
            <Download className="size-4" aria-hidden />
            Exportar CSV
          </Button>
        }
      >
        {ranking.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum vendedor com atividade neste filtro.
          </p>
        ) : (
          <TableWrap label="Ranking de vendedores">
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Vendedor</th>
                <th className={th}>Status</th>
                <th className={thR}>% meta</th>
                <th className={thR}>Realizado</th>
                <th className={thR}>Fat./dia útil</th>
                <th className={thR}>Notas/dia útil</th>
                <th className={thR}>Clientes</th>
                <th className={thR}>Ticket médio</th>
                <th className={thR}>vs mês ant.</th>
                <th className={thR}>vs ano ant.</th>
              </tr>
            </thead>
            <tbody>
              {ranking.map((r, k) => (
                <tr key={r.seller.id}>
                  <td className={td}>{k + 1}</td>
                  <td className={td}>{r.seller.name}</td>
                  <td className={td}>
                    <StatusBadge status={r.metrics.status} />
                  </td>
                  <td className={tdR}>{pct(r.metrics.attainment)}</td>
                  <td className={tdR}>{brl0(r.metrics.realized)}</td>
                  <td className={tdR}>{brl0(r.productivity.revenuePerWorkday)}</td>
                  <td className={tdR}>{num(r.productivity.invoicesPerWorkday, 2)}</td>
                  <td className={tdR}>{r.productivity.customers}</td>
                  <td className={tdR}>{brl0(r.productivity.averageTicket)}</td>
                  <td className={tdR}>{brl0(r.comparison.previousMonthSameCut)}</td>
                  <td className={tdR}>{brl0(r.comparison.previousYearSameCut)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </div>
  );
}

function Ind({
  label,
  value,
  metric,
  cmp,
  current,
  extra,
}: {
  label: string;
  value: ReactNode;
  metric: MetricKey;
  cmp?: Comparison;
  current?: number;
  extra?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {label}
        <InfoTip metric={metric} />
      </div>
      <div className="fp-num mt-1 text-lg font-semibold">{value}</div>
      {cmp && current !== undefined && (
        <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          <div>
            Mês anterior até o mesmo dia:{" "}
            <span className="fp-num">{brl0(cmp.previousMonthSameCut)}</span>
          </div>
          <div>
            Mesmo mês do ano anterior:{" "}
            <span className="fp-num">{brl0(cmp.previousYearSameCut)}</span>
          </div>
          <div>
            Média 3 meses: <span className="fp-num">{brl0(cmp.last3MonthsAvg)}</span>
          </div>
        </dl>
      )}
      {extra && <p className="mt-2 text-xs text-muted-foreground">{extra}</p>}
    </div>
  );
}
