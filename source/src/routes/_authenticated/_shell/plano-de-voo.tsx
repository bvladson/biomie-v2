import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Skeleton } from "@/components/ui/skeleton";
import { useGlobalFilters } from "@/hooks/use-filters";
import { appContextQuery, flightPlanQuery } from "@/lib/queries";
import { parsePeriod } from "@/domain/filters";
import { formatValue, monthLabel } from "@/domain/format";
import { hasPermission } from "@/domain/rbac";
import { STATUS_META, TARGET_LEVEL_LABELS, type FlightStatus } from "@/domain/flight-plan/config";
import { FlightPlanChart } from "@/components/flight-plan/FlightPlanChart";
import { VendorsTable } from "@/components/flight-plan/VendorsTable";
import { ActionsPanel } from "@/components/flight-plan/ActionsPanel";
import { VendorDrawer } from "@/components/flight-plan/VendorDrawer";
import type { FlightPlanMetrics } from "@/domain/flight-plan/engine";
import { FpKpi, KpiGridSkeleton, StatusBadge, signTone } from "@/components/flight-plan/parts";

const STATUSES = ["ON_TRACK", "ATTENTION", "RISK", "CRITICAL"] as const;
const pageSearch = z.object({
  vendor: z.string().uuid().optional().catch(undefined),
  q: z.string().max(80).optional().catch(undefined),
  st: z.enum(STATUSES).optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo")({
  validateSearch: pageSearch,
  head: () => ({
    meta: [
      { title: "Plano de Voo — BIOMIE" },
      {
        name: "description",
        content:
          "Meta ativa, linha de voo, ritmo por dias úteis, forecast e carteira por vendedor.",
      },
      { property: "og:title", content: "Plano de Voo — BIOMIE" },
      {
        property: "og:description",
        content:
          "Meta ativa, linha de voo, ritmo por dias úteis, forecast e carteira por vendedor.",
      },
    ],
  }),
  component: FlightPlanPage,
});

const MONTH_NAMES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

function FlightPlanPage() {
  const { resolved, companies } = useGlobalFilters();
  const q = resolved!;
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const canWrite = hasPermission(ctx.roles, "flightplan:write");
  const { data, isPending, error, isFetching } = useQuery({
    ...flightPlanQuery(q),
    placeholderData: (p) => p,
  });
  const { year, month } = parsePeriod(q.period);
  const company = companies.find((c) => c.id === q.company);
  const setSearch = (patch: Partial<z.infer<typeof pageSearch>>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace: true,
    } as never);
  const m = data?.summary;
  const stateLabel =
    data?.period.state === "closed"
      ? "Período encerrado"
      : data?.period.state === "future"
        ? "Período futuro"
        : "Mês em andamento";

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">
            {company?.name ?? "—"} · {monthLabel(year, month)}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Plano de Voo — {MONTH_NAMES[month - 1]} de {year}
          </h1>
          {data && (
            <p className="mt-1 text-sm text-muted-foreground">
              {stateLabel} · referência:{" "}
              <span className="font-medium text-foreground">
                {TARGET_LEVEL_LABELS[data.config.activeLevel]}
              </span>{" "}
              · {m!.workingDaysElapsed} de {m!.workingDaysTotal} dias úteis
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isFetching && !isPending && (
            <span className="text-xs text-muted-foreground">Atualizando…</span>
          )}
          {m && <StatusBadge status={m.status} className="px-2 py-1 text-xs" />}
        </div>
      </header>

      {error ? (
        <div className="panel p-8 text-center text-sm text-muted-foreground">{error.message}</div>
      ) : (
        <>
          {m && <Verdict m={m} state={data!.period.state} />}

          <section aria-label="Meta e execução" className="panel grid grid-cols-2 sm:grid-cols-4">
            {!m ? (
              <KpiGridSkeleton count={8} />
            ) : (
              <>
                <FpKpi
                  metricKey="target"
                  label="Meta ativa"
                  value={m.target}
                  emphasis
                  sub={`Base ${formatValue(data!.targets.BASE, "currency_compact")} · Desafio ${formatValue(data!.targets.CHALLENGE, "currency_compact")}`}
                />
                <FpKpi metricKey="revenue" label="Realizado" value={m.realized} emphasis />
                <FpKpi metricKey="target_attainment" value={m.attainment} emphasis />
                <FpKpi metricKey="ideal_today" value={m.idealToday} emphasis />
                <FpKpi
                  metricKey="deviation"
                  value={m.deviation}
                  emphasis
                  tone={signTone(m.deviation)}
                  sub={
                    m.deviation == null
                      ? undefined
                      : m.deviation >= 0
                        ? "▲ acima da linha"
                        : "▼ abaixo da linha"
                  }
                />
                <FpKpi metricKey="remaining_gap" value={m.remainingGap} emphasis />
                <FpKpi
                  metricKey="working_days"
                  label="Dias úteis restantes"
                  value={m.workingDaysRemaining}
                  emphasis
                />
                <FpKpi
                  metricKey="required_daily_pace"
                  value={m.requiredDailyPace}
                  emphasis
                  sub={m.gapUnreachable ? "Sem dias restantes" : "por dia útil"}
                />
              </>
            )}
          </section>

          <section
            aria-label="Ritmo e forecast"
            className="panel grid grid-cols-2 divide-border sm:grid-cols-4 lg:grid-cols-7 lg:divide-x"
          >
            {!m ? (
              <KpiGridSkeleton count={7} />
            ) : (
              <>
                <FpKpi
                  metricKey="current_daily_pace"
                  value={m.currentDailyPace}
                  sub="por dia útil"
                />
                <FpKpi
                  metricKey="run_rate_forecast"
                  value={m.runRateForecast}
                  sub={
                    m.runRateForecast != null && m.target
                      ? `${formatValue(m.runRateForecast / m.target, "percent")} da meta`
                      : undefined
                  }
                />
                <FpKpi metricKey="forecast_base" value={m.forecastBase} />
                <FpKpi
                  metricKey="forecast_probable"
                  value={m.forecastProbable}
                  sub={
                    m.forecastProbable != null && m.target
                      ? `${formatValue(m.forecastProbable / m.target, "percent")} da meta`
                      : undefined
                  }
                />
                <FpKpi
                  metricKey="forecast_commit"
                  value={m.forecastCommit}
                  sub={m.forecastCommit == null ? "Nenhum informado" : undefined}
                />
                <FpKpi
                  metricKey="portfolio"
                  value={m.portfolio}
                  sub={`Ponderada ${formatValue(m.portfolioWeighted, "currency_compact")}`}
                />
                <FpKpi
                  metricKey="gap_coverage"
                  value={m.gapCoverage}
                  sub={m.remainingGap === 0 ? "Meta atingida" : "não garante a meta"}
                />
              </>
            )}
          </section>

          <section className="panel p-4 md:p-5">
            <div className="mb-4">
              <h2 className="text-base font-semibold">Linha de voo</h2>
              <p className="text-xs text-muted-foreground">
                Acumulado do mês vs trajetória ideal distribuída por dias úteis
              </p>
            </div>
            {!data ? (
              <Skeleton className="h-[360px] w-full" />
            ) : (
              <FlightPlanChart
                timeline={data.timeline}
                target={data.summary.target}
                today={data.period.today}
              />
            )}
          </section>

          <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
            <section className="panel min-w-0 overflow-hidden">
              <div className="border-b px-4 py-3 md:px-5">
                <h2 className="text-base font-semibold">Vendedores</h2>
                <p className="text-xs text-muted-foreground">
                  Clique em um vendedor para abrir o Plano de Voo individual
                </p>
              </div>
              {!data ? (
                <Skeleton className="m-4 h-48" />
              ) : (
                <VendorsTable
                  vendors={data.vendors}
                  onSelect={(id) => setSearch({ vendor: id })}
                  search={search.q ?? ""}
                  status={(search.st as FlightStatus | undefined) ?? "ALL"}
                  onSearch={(v) => setSearch({ q: v || undefined })}
                  onStatus={(v) => setSearch({ st: v === "ALL" ? undefined : v })}
                />
              )}
              {data && Math.abs(data.reconciliation.difference) > 0.5 && (
                <p className="border-t px-5 py-2 text-xs text-muted-foreground">
                  Diferença de {formatValue(data.reconciliation.difference, "currency")} entre
                  empresa e soma dos vendedores (notas sem vendedor ou vendedores inativos).
                </p>
              )}
            </section>

            <section className="panel self-start">
              <div className="border-b px-4 py-3 md:px-5">
                <h2 className="text-base font-semibold">Ações prioritárias</h2>
                <p className="text-xs text-muted-foreground">
                  Regras determinísticas, recalculadas a cada leitura
                </p>
              </div>
              {!data ? (
                <Skeleton className="m-4 h-40" />
              ) : (
                <ActionsPanel
                  actions={data.actions}
                  company={q.company}
                  period={q.period}
                  canWrite={canWrite}
                  onSelectSeller={(id) => setSearch({ vendor: id })}
                />
              )}
            </section>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Status (configurável):{" "}
            {STATUSES.map((s) => STATUS_META[s].symbol + " " + STATUS_META[s].label).join(" · ")} —
            calculado por realizado ÷ ideal até hoje
            {data
              ? ` (≥ ${Math.round(data.config.status.onTrack * 100)}%, ≥ ${Math.round(data.config.status.attention * 100)}%, ≥ ${Math.round(data.config.status.risk * 100)}%, abaixo)`
              : ""}
            .
          </p>
        </>
      )}

      <VendorDrawer
        q={q}
        seller={search.vendor}
        canWrite={canWrite}
        onClose={() => setSearch({ vendor: undefined })}
      />
    </main>
  );
}

function Verdict({ m, state }: { m: FlightPlanMetrics; state: string }) {
  let text: string;
  if (state === "future")
    text = `Período ainda não iniciado. Meta de ${formatValue(m.target, "currency")} exigirá ${formatValue(m.requiredDailyPace, "currency")} por dia útil.`;
  else if (state === "closed")
    text = `Período encerrado com ${formatValue(m.realized, "currency")} (${formatValue(m.attainment, "percent")} da meta).`;
  else if (m.deviation == null) text = "Sem meta definida para os filtros atuais.";
  else if (m.workingDaysElapsed === 0) text = "Nenhum dia útil decorrido ainda.";
  else
    text = `${m.deviation >= 0 ? "Acima" : "Abaixo"} da linha de voo em ${formatValue(Math.abs(m.deviation), "currency")}. Faltam ${formatValue(m.remainingGap, "currency")} em ${m.workingDaysRemaining} dias úteis — ${formatValue(m.requiredDailyPace, "currency")}/dia contra ritmo atual de ${formatValue(m.currentDailyPace, "currency")}/dia.`;
  return <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">{text}</p>;
}
