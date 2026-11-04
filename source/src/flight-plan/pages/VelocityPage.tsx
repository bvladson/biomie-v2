import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { brl0, dateBr, dayMonth, num, pct } from "../lib/format";
import { perWorkday } from "../lib/derived";
import { useFilters, usePeriodMonths, usePlan } from "../lib/hooks";
import {
  missingTargetLabel,
  partialPeriod,
  quarterOf,
  saturdayNote,
  workdaysLabel,
  yearOf,
} from "../lib/period";
import {
  ErrorState,
  InfoTip,
  Kpi,
  Loading,
  Panel,
  StatusBadge,
  TableWrap,
  td,
  tdR,
  th,
  thR,
} from "../components/bits";
import { weekday } from "../lib/dates";

const WD = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function VelocityPage() {
  const plan = usePlan();
  const sat = useFilters().company.saturdayWeight;
  if (plan.isPending) return <Loading />;
  if (plan.isError) return <ErrorState error={plan.error} retry={() => plan.refetch()} />;
  const p = plan.data,
    m = p.summary;
  const last3Daily = perWorkday(p.indicators.comparison.last3MonthsAvg, m.workdaysTotal);
  const first = weekday(p.calendar[0]!.date);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="Ritmo necessário"
          metric="requiredPace"
          value={m.gapUnreachable ? "Inalcançável" : `${brl0(m.requiredDailyPace)}/dia`}
          sub={workdaysLabel(m.workdaysRemaining, sat, "restantes")}
          tone={
            m.requiredDailyPace !== null &&
            m.currentDailyPace !== null &&
            m.requiredDailyPace > m.currentDailyPace
              ? "bad"
              : "neutral"
          }
        />
        <Kpi
          label="Ritmo atual"
          metric="currentPace"
          value={`${brl0(m.currentDailyPace)}/dia`}
          sub={`${num(m.workdaysElapsed, 2)} de ${workdaysLabel(m.workdaysTotal, sat)}`}
        />
        <Kpi
          label="Média dos últimos 3 meses"
          metric="workdays"
          value={`${brl0(last3Daily)}/dia`}
          sub={`média mensal ${brl0(p.indicators.comparison.last3MonthsAvg)}, sobre os dias úteis deste mês`}
        />
      </div>

      <Panel title="Semanas do mês">
        <div className="h-56 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart
              data={p.weeks.map((w) => ({
                name: `S${w.index}`,
                Meta: w.target,
                Realizado: w.realized,
                "Mês anterior": w.previousMonthSameWeek,
              }))}
            >
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis
                tickFormatter={(v: number) => v.toLocaleString("pt-BR", { notation: "compact" })}
                tick={{ fontSize: 11 }}
                width={44}
              />
              <Tooltip formatter={(v: number) => brl0(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Meta" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Realizado" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
              <Bar
                dataKey="Mês anterior"
                fill="color-mix(in oklab, var(--chart-3) 45%, transparent)"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4">
          <TableWrap label="Semanas do mês">
            <thead>
              <tr>
                <th className={th}>Semana</th>
                <th className={thR}>{`Dias úteis${saturdayNote(sat)}`}</th>
                <th className={thR}>Meta da semana</th>
                <th className={thR}>Realizado</th>
                <th className={thR}>% </th>
                <th className={thR}>Mesma semana mês anterior</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {p.weeks.map((w) => (
                <tr
                  key={w.index}
                  className={w.current ? "bg-accent/60" : undefined}
                  aria-current={w.current ? "true" : undefined}
                >
                  <td className={td}>
                    S{w.index} · {dayMonth(w.start)} a {dayMonth(w.end)}
                    {w.current && (
                      <span className="ml-2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                        atual
                      </span>
                    )}
                  </td>
                  <td className={tdR}>{num(w.workdays, 2)}</td>
                  <td className={tdR}>{w.target === null ? "Sem meta" : brl0(w.target)}</td>
                  <td className={tdR}>{w.realized === null ? "—" : brl0(w.realized)}</td>
                  <td className={tdR}>
                    {w.target && w.realized !== null ? pct(w.realized / w.target) : "—"}
                  </td>
                  <td className={tdR}>{brl0(w.previousMonthSameWeek)}</td>
                  <td className={td}>
                    {w.realized === null ? "—" : <StatusBadge status={w.status} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      </Panel>

      <Panel
        title={
          <span className="flex items-center gap-1">
            Calendário do mês <InfoTip metric="workdays" />
          </span>
        }
      >
        <div
          className="grid grid-cols-7 gap-1 text-center text-xs"
          role="grid"
          aria-label="Calendário com peso de cada dia"
        >
          {WD.map((d) => (
            <div key={d} role="columnheader" className="py-1 font-semibold text-muted-foreground">
              {d}
            </div>
          ))}
          {Array.from({ length: first }, (_, i) => (
            <div key={`e${i}`} aria-hidden />
          ))}
          {p.calendar.map((d) => (
            <div
              key={d.date}
              role="gridcell"
              aria-label={`${dateBr(d.date)}: peso ${num(d.weight, 2)}${d.holiday ? `, feriado ${d.holiday}` : ""}`}
              className={`min-h-14 rounded border p-1 ${d.weight === 0 ? "bg-muted text-muted-foreground" : d.weight < 1 ? "bg-accent/50" : "bg-card"} ${d.date === p.period.today ? "ring-2 ring-primary" : ""}`}
            >
              <div className="font-semibold">{Number(d.date.slice(8))}</div>
              <div className="fp-num">{num(d.weight, 2)}</div>
              {d.holiday && (
                <div className="truncate text-[10px]" title={d.holiday}>
                  {d.holiday}
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-3 md:grid-cols-2">
        <PeriodCard label={p.quarter.label} months={quarterOf(p.query.month)} sat={sat} />
        <PeriodCard label={p.year.label} months={yearOf(p.query.month)} sat={sat} />
      </div>
    </div>
  );
}

function PeriodCard({ label, months, sat }: { label: string; months: string[]; sat: number }) {
  const q = usePeriodMonths(months);
  if (q.isPending)
    return (
      <Panel title={label}>
        <Loading />
      </Panel>
    );
  if (q.isError)
    return (
      <Panel title={label}>
        <ErrorState error={q.error} retry={() => q.refetch()} />
      </Panel>
    );
  const s = partialPeriod(q.data);
  const warn = missingTargetLabel(s);
  return (
    <Panel title={label}>
      {warn && (
        <p
          role="note"
          className="mb-3 rounded border border-warning/40 bg-warning/10 p-2 text-sm text-warning"
        >
          {warn}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Realizado total</dt>
          <dd className="fp-num font-semibold">{brl0(s.realizedTotal)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Meta (meses com meta)</dt>
          <dd className="fp-num font-semibold">
            {s.target === null ? "Sem meta" : brl0(s.target)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">% da meta</dt>
          <dd className="fp-num font-semibold">{pct(s.attainment)}</dd>
          {warn && s.target !== null && (
            <dd className="text-xs text-muted-foreground">
              realizado nos meses com meta: {brl0(s.realizedWithTarget)}
            </dd>
          )}
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground">
            Ritmo para fechar a meta acumulada <InfoTip metric="accumulatedPace" />
          </dt>
          <dd className="fp-num font-semibold">
            {s.requiredDailyPace === null ? "—" : `${brl0(s.requiredDailyPace)}/dia`}
          </dd>
          {s.target !== null && (
            <dd className="text-xs text-muted-foreground">
              {workdaysLabel(s.workdaysRemaining, sat, "restantes")}
            </dd>
          )}
        </div>
      </dl>
    </Panel>
  );
}
