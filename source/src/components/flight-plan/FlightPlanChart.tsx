import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatValue, shortDate } from "@/domain/format";
import type { LegacyTimelinePoint as TimelinePoint } from "@/domain/flight-plan/engine";

const config = {
  realizedCumulative: { label: "Realizado acumulado", color: "var(--chart-1)" },
  idealCumulative: { label: "Linha de voo (ideal)", color: "var(--muted-foreground)" },
  projection: { label: "Run rate", color: "var(--chart-3)" },
  forecast: { label: "Forecast provável", color: "var(--chart-2)" },
} satisfies ChartConfig;

interface TooltipPayload {
  payload: TimelinePoint;
}

function FpTooltip({
  active,
  payload,
  target,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  target: number;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const diff = p.realizedCumulative == null ? null : p.realizedCumulative - p.idealCumulative;
  const row = (label: string, value: string, strong = false) => (
    <div className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold tabular" : "tabular"}>{value}</span>
    </div>
  );
  return (
    <div className="min-w-56 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">
        {shortDate(p.date)} {p.working ? "" : "· não útil"} {p.isToday ? "· hoje" : ""}
      </div>
      {p.realizedCumulative != null &&
        row("Realizado acum.", formatValue(p.realizedCumulative, "currency"), true)}
      {row("Ideal acum.", formatValue(p.idealCumulative, "currency"))}
      {diff != null &&
        row("Diferença", `${diff >= 0 ? "▲ +" : "▼ "}${formatValue(diff, "currency")}`)}
      {p.realizedCumulative != null &&
        target > 0 &&
        row("% da meta", formatValue(p.realizedCumulative / target, "percent"))}
      {p.projection != null &&
        p.realizedCumulative == null &&
        row("Run rate", formatValue(p.projection, "currency"))}
      {p.forecast != null &&
        p.realizedCumulative == null &&
        row("Forecast provável", formatValue(p.forecast, "currency"))}
    </div>
  );
}

export function FlightPlanChart({
  timeline,
  target,
  today,
  height = 360,
}: {
  timeline: TimelinePoint[];
  target: number;
  today: string;
  height?: number;
}) {
  const hasToday = timeline.some((p) => p.date === today);
  return (
    <div>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
        <ComposedChart data={timeline} margin={{ left: 8, right: 16, top: 16 }}>
          <defs>
            <linearGradient id="fpFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-realizedCumulative)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--chart-4)" stopOpacity={0.06} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            fontSize={11}
          />
          <YAxis
            tickFormatter={(v: number) => formatValue(v, "currency_compact")}
            tickLine={false}
            axisLine={false}
            width={72}
            fontSize={11}
          />
          <ChartTooltip content={<FpTooltip target={target} />} />
          {target > 0 && (
            <ReferenceLine
              y={target}
              stroke="var(--foreground)"
              strokeOpacity={0.5}
              strokeDasharray="2 4"
              label={{
                value: `Meta ${formatValue(target, "currency_compact")}`,
                position: "insideTopLeft",
                fontSize: 11,
                fill: "var(--muted-foreground)",
              }}
            />
          )}
          {hasToday && (
            <ReferenceLine
              x={today}
              stroke="var(--foreground)"
              strokeOpacity={0.35}
              label={{
                value: "Hoje",
                position: "top",
                fontSize: 11,
                fill: "var(--muted-foreground)",
              }}
            />
          )}
          <Line
            dataKey="idealCumulative"
            type="linear"
            stroke="var(--color-idealCumulative)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Area
            dataKey="realizedCumulative"
            type="monotone"
            stroke="var(--color-realizedCumulative)"
            strokeWidth={2.5}
            fill="url(#fpFill)"
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="projection"
            type="linear"
            stroke="var(--color-projection)"
            strokeWidth={1.5}
            strokeDasharray="1 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="forecast"
            type="linear"
            stroke="var(--color-forecast)"
            strokeWidth={1.75}
            strokeDasharray="8 4"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>
      <ul
        className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"
        aria-label="Legenda"
      >
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-5 bg-chart-1" />
          Realizado acumulado (linha contínua)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="w-5 border-t-2 border-dashed border-muted-foreground" />
          Linha de voo ideal (tracejada)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="w-5 border-t-2 border-dotted border-chart-3" />
          Run rate (pontilhada)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="w-5 border-t-2 border-dashed border-chart-2" />
          Forecast provável (traço longo)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="w-5 border-t border-dotted border-foreground" />
          Meta final
        </li>
      </ul>
    </div>
  );
}
