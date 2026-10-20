import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatValue, shortDate } from "@/domain/format";
import type { CockpitDTO } from "@/lib/repositories/analytics.repository.server";

const config = {
  cumulative: { label: "Realizado acumulado", color: "var(--chart-1)" },
  targetCumulative: { label: "Linha da meta", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function FlightChart({ daily }: { daily: CockpitDTO["daily"] }) {
  return (
    <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
      <ComposedChart data={daily} margin={{ left: 8, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillCum" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-cumulative)" stopOpacity={0.22} />
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
          tickFormatter={(v) => formatValue(v, "currency_compact")}
          tickLine={false}
          axisLine={false}
          width={72}
          fontSize={11}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, p) => (p?.[0]?.payload?.date ? shortDate(p[0].payload.date) : "")}
              formatter={(v, name) => (
                <div className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">
                    {config[name as keyof typeof config]?.label}
                  </span>
                  <span className="font-medium tabular">{formatValue(Number(v), "currency")}</span>
                </div>
              )}
            />
          }
        />
        <Line
          dataKey="targetCumulative"
          type="monotone"
          stroke="var(--color-targetCumulative)"
          strokeDasharray="5 4"
          strokeWidth={1.5}
          dot={false}
        />
        <Area
          dataKey="cumulative"
          type="monotone"
          stroke="var(--color-cumulative)"
          strokeWidth={2}
          fill="url(#fillCum)"
          connectNulls={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
