import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { metric } from "@/domain/metrics/registry";
import { formatDelta, formatValue } from "@/domain/format";
import { COMPARISON_LABELS } from "@/domain/comparison";
import type { AnalyticsQuery } from "@/domain/filters";
import { salesSummaryQuery } from "@/lib/queries";
import type { SalesKpi } from "@/lib/repositories/sales.repository.server";
import { cn } from "@/lib/utils";

function KpiTile({ k }: { k: SalesKpi }) {
  const def = metric(k.key);
  const shown = k.comparisons.filter(
    (c) => c.kind === "PREVIOUS_PERIOD" || c.kind === "SAME_PERIOD_LAST_YEAR",
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5 p-4">
      <div className="flex items-center gap-1.5">
        <span className="eyebrow truncate">{def.name}</span>
        <Tooltip>
          <TooltipTrigger aria-label={`Sobre ${def.name}`}>
            <Info className="size-3 text-muted-foreground/70" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>{def.description}</p>
            <p className="mt-1 font-mono text-[10px] opacity-80">{def.formula}</p>
            {def.notes && <p className="mt-1 text-[11px] opacity-80">{def.notes}</p>}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="truncate text-lg font-semibold tracking-tight tabular">
        {formatValue(k.value, def.format)}
      </div>
      {shown.map((c) => {
        const good =
          c.percent == null || def.polarity === "neutral"
            ? null
            : def.polarity === "up"
              ? c.percent >= 0
              : c.percent <= 0;
        return (
          <div key={c.kind} className="text-xs text-muted-foreground">
            <span
              className={cn(
                "font-medium tabular",
                good === true && "text-success",
                good === false && "text-destructive",
              )}
            >
              {formatDelta(c.percent)}
            </span>{" "}
            <span className="tabular">
              ({c.absolute != null && c.absolute > 0 ? "+" : ""}
              {formatValue(c.absolute, def.format === "percent" ? "percent" : def.format)})
            </span>{" "}
            {COMPARISON_LABELS[c.kind]}
          </div>
        );
      })}
    </div>
  );
}

export function SalesSummary({ q }: { q: AnalyticsQuery }) {
  const { data, isPending, error } = useQuery(salesSummaryQuery(q));
  if (error) return <p className="panel p-6 text-sm text-muted-foreground">{error.message}</p>;
  return (
    <section
      aria-label="Indicadores de vendas"
      className="panel grid grid-cols-2 divide-x divide-y sm:grid-cols-3 lg:grid-cols-4 [&>*]:border-border"
    >
      {isPending || !data
        ? Array.from({ length: 11 }, (_, i) => (
            <div key={i} className="flex flex-col gap-3 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-28" />
            </div>
          ))
        : data.kpis.map((k) => <KpiTile key={k.key} k={k} />)}
    </section>
  );
}
