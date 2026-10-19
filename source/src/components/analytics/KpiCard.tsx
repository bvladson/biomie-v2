import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { metric } from "@/domain/metrics/registry";
import { formatDelta, formatValue } from "@/domain/format";
import type { KpiValue } from "@/lib/repositories/analytics.repository.server";
import { cn } from "@/lib/utils";

function Delta({
  value,
  label,
  polarity,
}: {
  value: number | null;
  label: string;
  polarity: "up" | "down" | "neutral";
}) {
  if (value == null) return null;
  const good = polarity === "neutral" ? null : polarity === "up" ? value >= 0 : value <= 0;
  return (
    <span className="text-xs text-muted-foreground">
      <span
        className={cn(
          "font-medium tabular",
          good === true && "text-success",
          good === false && "text-destructive",
        )}
      >
        {formatDelta(value)}
      </span>{" "}
      {label}
    </span>
  );
}

export function KpiCard({ kpi, emphasis = false }: { kpi: KpiValue; emphasis?: boolean }) {
  const def = metric(kpi.key);
  return (
    <div className={cn("flex flex-col gap-2 p-4", emphasis && "md:p-5")}>
      <div className="flex items-center gap-1.5">
        <span className="eyebrow">{def.name}</span>
        <Tooltip>
          <TooltipTrigger aria-label={`Sobre ${def.name}`}>
            <Info className="size-3 text-muted-foreground/70" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{def.description}</TooltipContent>
        </Tooltip>
      </div>
      <div
        className={cn(
          "font-semibold tracking-tight tabular",
          emphasis ? "text-2xl md:text-[28px]" : "text-xl",
        )}
      >
        {formatValue(kpi.value, def.format)}
      </div>
      <div className="flex min-h-4 flex-col gap-0.5">
        <Delta value={kpi.vsPreviousMonth} label="vs mês anterior" polarity={def.polarity} />
        <Delta value={kpi.vsPreviousYear} label="vs ano anterior" polarity={def.polarity} />
        {kpi.hint && <span className="text-xs text-muted-foreground">{kpi.hint}</span>}
      </div>
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}
