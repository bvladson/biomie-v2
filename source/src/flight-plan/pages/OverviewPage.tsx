import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BarChart3, CalendarX, Gauge, Map, Target, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { FlightPlan } from "../api/contract";
import { flightPlanApi } from "../api";
import { brl0, monthLabel, num, pct } from "../lib/format";
import { fpKey, useFilters, useMe, usePlan } from "../lib/hooks";
import { isManager } from "../lib/permissions";
import { keepSearch } from "@/components/entities/shared";
import { Empty, ErrorState, InfoTip, Loading, Panel, StatusBadge } from "../components/bits";
import { FlightLineChart } from "../components/FlightLineChart";
import { SellerTable } from "../components/SellerTable";
import { workdaysLabel } from "../lib/period";
import { Button } from "@/components/ui/button";

export function verdict(p: FlightPlan, saturdayWeight: number) {
  const m = p.summary;
  if (m.target === null) return null;
  if (p.period.state === "closed")
    return `Mês encerrado com ${brl0(m.realized)}, ${pct(m.attainment)} da meta.`;
  if (p.period.state === "future")
    return `Mês ainda não começou. Meta de ${brl0(m.target)} em ${workdaysLabel(m.workdaysTotal, saturdayWeight)}.`;
  if (m.remainingGap === 0) return `Meta atingida: ${brl0(m.realized)} (${pct(m.attainment)}).`;
  const pos =
    (m.deviation ?? 0) >= 0
      ? `Acima da linha de voo em ${brl0(m.deviation)}.`
      : `Abaixo da linha de voo em ${brl0(Math.abs(m.deviation ?? 0))}.`;
  if (m.gapUnreachable)
    return `${pos} Faltam ${brl0(m.remainingGap)} e não há mais dias úteis no mês.`;
  return `${pos} Faltam ${brl0(m.remainingGap)} em ${workdaysLabel(m.workdaysRemaining, saturdayWeight)}: ${brl0(m.requiredDailyPace)} por dia contra ${brl0(m.currentDailyPace)} por dia hoje.`;
}

export function OverviewPage() {
  const f = useFilters();
  const plan = usePlan();
  const me = useMe();
  const inits = useQuery({
    queryKey: fpKey(f.persona, "initiatives", f.query),
    queryFn: () => flightPlanApi.listInitiatives(f.query),
  });
  const alerts = useQuery({
    queryKey: fpKey(f.persona, "alerts", f.query),
    queryFn: () => flightPlanApi.listAlerts(f.query),
  });
  if (plan.isPending) return <Loading />;
  if (plan.isError) return <ErrorState error={plan.error} retry={() => plan.refetch()} />;
  const p = plan.data,
    m = p.summary;
  // Gestor só edita metas dos vendedores da equipe: sem nenhum vendedor no escopo, o Destino é só leitura.
  const canEditTargets =
    !!me.data && (isManager(me.data) || (me.data.roles.includes("GESTOR") && p.sellers.length > 0));
  const currentWeek = p.weeks.find((w) => w.current);
  const openAlerts = (alerts.data ?? []).filter(
    (a) => a.state === "OPEN" || a.state === "ACKNOWLEDGED",
  );
  const byPriority = [1, 2, 3].map((n) => openAlerts.filter((a) => a.priority === n).length);
  const lateCorrective = (inits.data?.rows ?? []).filter(
    (i) =>
      i.alertKey && i.dueDate < p.period.today && i.status !== "DONE" && i.status !== "CANCELLED",
  ).length;
  const v = verdict(p, f.company.saturdayWeight);

  return (
    <div className="space-y-5">
      {p.calendarMissing && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
        >
          <CalendarX className="size-4" aria-hidden />
          Calendário ausente: sem feriados cadastrados para {p.period.start.slice(0, 4)}. Os dias
          úteis podem estar errados.
        </div>
      )}
      {m.target === null ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-warning/40 bg-card p-5">
          <p className="text-lg font-semibold">Sem meta para {monthLabel(f.month)}</p>
          <p className="text-sm text-muted-foreground">
            Sem meta, Velocidade, Painel e Correção de rota ficam sem referência. O realizado do mês
            é {brl0(m.realized)}.
          </p>
          {canEditTargets && (
            <Button asChild>
              <Link to="/plano-de-voo/destino" search={keepSearch}>
                Cadastrar meta
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-5 md:flex-row md:items-center">
          <StatusBadge status={m.status} className="self-start text-sm" />
          <p className="text-base font-medium md:text-lg" aria-live="polite">
            {v}
          </p>
        </div>
      )}
      {m.realized === 0 && p.period.state !== "future" && (
        <Empty title="Sem faturamento no mês">
          Nenhuma nota válida em {monthLabel(f.month)} para este filtro até{" "}
          {p.period.today.split("-").reverse().join("/")}.
        </Empty>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <PillarCard
          icon={<Target className="size-4" />}
          title="Destino"
          to="/plano-de-voo/destino"
          value={m.target === null ? "Sem meta" : brl0(m.target)}
          sub={
            p.targetSource === "company"
              ? "Meta Ativa · meta da empresa"
              : p.targetSource === "sellers"
                ? "Meta Ativa · soma dos vendedores"
                : "Nenhuma meta cadastrada"
          }
          linkLabel={canEditTargets ? "Editar metas" : "Ver metas"}
        />
        <PillarCard
          icon={<Map className="size-4" />}
          title="Rota"
          to="/plano-de-voo/rota"
          value={inits.data ? `${inits.data.coverage.open} abertas` : "…"}
          sub={
            inits.data
              ? `${inits.data.coverage.late} atrasadas · cobertura ${inits.data.coverage.coverage === null ? (inits.data.coverage.remainingGap === 0 ? "meta atingida" : "—") : pct(inits.data.coverage.coverage)}`
              : "Carregando"
          }
        />
        <PillarCard
          icon={<Gauge className="size-4" />}
          title="Velocidade"
          to="/plano-de-voo/velocidade"
          value={
            m.requiredDailyPace === null
              ? m.gapUnreachable
                ? "Inalcançável"
                : "—"
              : `${brl0(m.requiredDailyPace)}/dia`
          }
          sub={`atual ${brl0(m.currentDailyPace)}/dia${currentWeek ? ` · semana ${currentWeek.index}: ${brl0(currentWeek.realized)} de ${brl0(currentWeek.target)}` : ""}`}
        />
        <PillarCard
          icon={<BarChart3 className="size-4" />}
          title="Painel"
          to="/plano-de-voo/painel"
          value={brl0(m.realized)}
          sub={`${pct(m.attainment)} da meta · previsão provável ${brl0(m.forecastProbable)}`}
        />
        <PillarCard
          icon={<Wrench className="size-4" />}
          title="Correção de rota"
          to="/plano-de-voo/correcao"
          value={alerts.data ? `${openAlerts.length} alertas` : "…"}
          sub={
            alerts.data
              ? `Alta ${byPriority[0]} · Média ${byPriority[1]} · Baixa ${byPriority[2]} · ${lateCorrective} ações atrasadas`
              : "Carregando"
          }
        />
      </div>

      <Panel
        title={
          <span className="flex items-center gap-1">
            Linha de voo <InfoTip metric="ideal" />
          </span>
        }
      >
        <FlightLineChart data={p.timeline} />
      </Panel>

      <Panel title="Vendedores">
        <SellerTable plan={p} />
      </Panel>

      <footer
        role="status"
        className={`rounded-lg border p-3 text-sm ${p.reconciliation.difference === 0 ? "border-success/30 bg-success/5 text-success" : "border-destructive/30 bg-destructive/5 text-destructive"}`}
      >
        {p.reconciliation.difference === 0
          ? `✓ Soma dos vendedores igual ao faturamento da empresa (${brl0(p.reconciliation.company)}).`
          : `Diferença de ${brl0(p.reconciliation.difference)} entre empresa (${brl0(p.reconciliation.company)}) e vendedores (${brl0(p.reconciliation.sellers)}). Motivo: ${p.reconciliation.reason ?? "não identificado"}.`}
      </footer>
    </div>
  );
}

function PillarCard({
  icon,
  title,
  value,
  sub,
  to,
  linkLabel = "Abrir",
}: {
  icon: ReactNode;
  title: string;
  value: string;
  sub: string;
  to:
    | "/plano-de-voo/destino"
    | "/plano-de-voo/rota"
    | "/plano-de-voo/velocidade"
    | "/plano-de-voo/painel"
    | "/plano-de-voo/correcao";
  linkLabel?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <span aria-hidden className="text-primary">
          {icon}
        </span>
        {title}
      </div>
      <div className="fp-num mt-2 truncate text-xl font-semibold">{value}</div>
      <div className="mt-1 flex-1 text-xs text-muted-foreground">{sub}</div>
      <Link
        to={to}
        search={keepSearch}
        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {linkLabel}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}
