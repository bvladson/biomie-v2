import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatValue } from "@/domain/format";
import type { AnalyticsQuery } from "@/domain/filters";
import { salesTimelineQuery } from "@/lib/queries";
import type { Grain, TimelineBucket } from "@/lib/repositories/sales.repository.server";

type Measure = "revenue" | "units" | "invoices" | "ticket";
const MEASURES: Record<Measure, { label: string; fmt: "currency" | "integer" }> = {
  revenue: { label: "Valor", fmt: "currency" },
  units: { label: "Quantidade", fmt: "integer" },
  invoices: { label: "Notas", fmt: "integer" },
  ticket: { label: "Ticket", fmt: "currency" },
};
type Cmp = "none" | "previous" | "lastYear";

function label(b: string, grain: Grain) {
  const [y, m, d] = b.split("-");
  return grain === "month" ? `${m}/${y?.slice(2)}` : `${d}/${m}`;
}

export function SalesEvolution({ q }: { q: AnalyticsQuery }) {
  const [grain, setGrain] = useState<Grain>("day");
  const [measure, setMeasure] = useState<Measure>("revenue");
  const [cmp, setCmp] = useState<Cmp>("previous");
  const { data, isPending, error } = useQuery(salesTimelineQuery(q, grain));
  const val = (b: TimelineBucket | undefined) => (b && !b.future ? b[measure] : null);
  const points = (data?.current ?? []).map((b, i) => ({
    label: label(b.bucket, grain),
    atual: val(b),
    comparacao:
      cmp === "none" ? null : val((cmp === "previous" ? data!.previous : data!.lastYear)[i]),
  }));
  const fmt = MEASURES[measure].fmt;

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Evolução</h2>
        <ToggleGroup
          type="single"
          size="sm"
          value={grain}
          onValueChange={(v) => v && setGrain(v as Grain)}
          aria-label="Granularidade"
        >
          <ToggleGroupItem value="day">Diária</ToggleGroupItem>
          <ToggleGroupItem value="week">Semanal</ToggleGroupItem>
          <ToggleGroupItem value="month">Mensal</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          type="single"
          size="sm"
          value={measure}
          onValueChange={(v) => v && setMeasure(v as Measure)}
          aria-label="Medida"
        >
          {(Object.keys(MEASURES) as Measure[]).map((m) => (
            <ToggleGroupItem key={m} value={m}>
              {MEASURES[m].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          size="sm"
          value={cmp}
          onValueChange={(v) => v && setCmp(v as Cmp)}
          aria-label="Comparação"
        >
          <ToggleGroupItem value="none">Sem comparação</ToggleGroupItem>
          <ToggleGroupItem value="previous">Período anterior</ToggleGroupItem>
          <ToggleGroupItem value="lastYear">Ano anterior</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="h-80 p-4">
        {error ? (
          <p className="text-sm text-muted-foreground">{error.message}</p>
        ) : isPending ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ left: 8, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="var(--muted-foreground)"
                width={70}
                tickFormatter={(v: number) =>
                  formatValue(v, fmt === "currency" ? "currency_compact" : "integer")
                }
              />
              <Tooltip
                formatter={(v: number) => formatValue(v, fmt)}
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="atual"
                name="Período atual"
                stroke="var(--primary)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
              {cmp !== "none" && (
                <Line
                  type="monotone"
                  dataKey="comparacao"
                  name={cmp === "previous" ? "Período anterior" : "Ano anterior"}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="5 4"
                  dot={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
