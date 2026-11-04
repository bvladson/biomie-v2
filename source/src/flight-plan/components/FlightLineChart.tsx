import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimelinePoint } from "../api/contract";
import { brl0, dayMonth } from "../lib/format";

const compact = (v: number) =>
  v.toLocaleString("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

export function FlightLineChart({
  data,
  height = 300,
}: {
  data: TimelinePoint[];
  height?: number;
}) {
  const off = data.filter((d) => d.weight === 0);
  const today = data.find((d) => d.isToday);
  return (
    <figure className="min-w-0">
      <div style={{ height }} className="w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            {off.map((d) => (
              <ReferenceArea
                key={d.date}
                x1={d.date}
                x2={d.date}
                fill="var(--muted-foreground)"
                fillOpacity={0.08}
                ifOverflow="extendDomain"
              />
            ))}
            <XAxis
              dataKey="date"
              tickFormatter={dayMonth}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              interval="preserveStartEnd"
              minTickGap={18}
            />
            <YAxis
              tickFormatter={compact}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              width={48}
            />
            <Tooltip
              formatter={(v: number, n: string) => [brl0(v), n]}
              labelFormatter={(l: string) => dayMonth(l)}
              contentStyle={{ borderRadius: 8, border: "1px solid var(--border)" }}
            />
            <Area
              type="monotone"
              dataKey="forecast"
              name="Previsão provável"
              stroke="var(--chart-4)"
              fill="var(--chart-4)"
              fillOpacity={0.15}
              strokeWidth={2}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="idealCumulative"
              name="Linha ideal"
              stroke="var(--chart-2)"
              strokeDasharray="6 4"
              dot={false}
              strokeWidth={1.5}
            />
            <Line
              type="monotone"
              dataKey="projection"
              name="Projeção pelo ritmo"
              stroke="var(--chart-3)"
              strokeDasharray="2 3"
              dot={false}
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="realizedCumulative"
              name="Realizado"
              stroke="var(--chart-1)"
              dot={false}
              strokeWidth={2.5}
            />
            {today && (
              <ReferenceLine
                x={today.date}
                stroke="var(--foreground)"
                strokeDasharray="3 3"
                label={{
                  value: "Hoje",
                  position: "insideTopLeft",
                  fontSize: 11,
                  fill: "var(--foreground)",
                }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Legend color="var(--chart-1)" label="Realizado acumulado" />
        <Legend color="var(--chart-2)" label="Linha ideal" dashed />
        <Legend color="var(--chart-3)" label="Projeção pelo ritmo" dashed />
        <Legend color="var(--chart-4)" label="Previsão provável" />
        <span className="flex items-center gap-1">
          <span className="inline-block size-3 rounded-sm bg-muted-foreground/15" aria-hidden />
          Fim de semana e feriado
        </span>
      </figcaption>
    </figure>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <svg width="18" height="6" aria-hidden>
        <line
          x1="0"
          y1="3"
          x2="18"
          y2="3"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray={dashed ? "4 3" : undefined}
        />
      </svg>
      {label}
    </span>
  );
}
