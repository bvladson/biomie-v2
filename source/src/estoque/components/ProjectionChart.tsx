import { BarChart, Bar, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { money } from "../lib/format";
export function ProjectionChart({
  data,
}: {
  data: { curve: string; current: number; projected: number }[];
}) {
  return (
    <div className="min-w-0">
      <ChartContainer
        className="h-72 w-full"
        config={{
          current: { label: "Atual", color: "var(--chart-2)" },
          projected: { label: "Projetado", color: "var(--chart-1)" },
        }}
      >
        <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 8, top: 10, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="curve" tickLine={false} axisLine={false} />
          <YAxis
            width={60}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${(Number(v) / 1000).toLocaleString("pt-BR")} mil`}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(v, n) => (
                  <span>
                    {n === "current" ? "Atual" : "Projetado"}: {money(Number(v))}
                  </span>
                )}
              />
            }
          />
          <Bar dataKey="current" fill="var(--color-current)" radius={3} isAnimationActive={false} />
          <Bar
            dataKey="projected"
            fill="var(--color-projected)"
            radius={3}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <p className="mt-2 text-xs text-muted-foreground">Atual · Projetado (R$ a custo)</p>
    </div>
  );
}
