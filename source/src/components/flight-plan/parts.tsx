import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { metric } from "@/domain/metrics/registry";
import { formatValue, type ValueFormat } from "@/domain/format";
import { STATUS_META, type FlightStatus } from "@/domain/flight-plan/config";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  success: "text-success border-success/30 bg-success/10",
  warning: "text-warning border-warning/30 bg-warning/10",
  risk: "text-risk border-risk/30 bg-risk/10",
  destructive: "text-destructive border-destructive/30 bg-destructive/10",
};

/** Status communicates by symbol + text, not color only. */
export function StatusBadge({
  status,
  className,
}: {
  status: FlightStatus | null;
  className?: string;
}) {
  if (!status)
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground",
          className,
        )}
      >
        — Sem avaliação
      </span>
    );
  const s = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        TONE[s.tone],
        className,
      )}
    >
      <span aria-hidden>{s.symbol}</span>
      {s.label}
    </span>
  );
}

interface FpKpiProps {
  metricKey: string;
  value: number | null;
  label?: string;
  format?: ValueFormat;
  sub?: React.ReactNode;
  emphasis?: boolean;
  tone?: "good" | "bad" | null;
}

export function FpKpi({ metricKey, value, label, format, sub, emphasis, tone }: FpKpiProps) {
  const def = metric(metricKey);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 p-4", emphasis && "md:p-5")}>
      <div className="flex items-center gap-1.5">
        <span className="eyebrow truncate">{label ?? def.name}</span>
        <Tooltip>
          <TooltipTrigger aria-label={`Sobre ${label ?? def.name}`}>
            <Info className="size-3 text-muted-foreground/70" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>{def.description}</p>
            <p className="mt-1 font-mono text-[10px] opacity-80">{def.formula}</p>
            {def.notes && <p className="mt-1 text-[11px] opacity-80">{def.notes}</p>}
          </TooltipContent>
        </Tooltip>
      </div>
      <div
        className={cn(
          "truncate font-semibold tracking-tight tabular",
          emphasis ? "text-xl md:text-2xl" : "text-lg",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive",
        )}
      >
        {formatValue(value, format ?? def.format)}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function KpiGridSkeleton({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-28" />
        </div>
      ))}
    </>
  );
}

export const signTone = (v: number | null | undefined) =>
  v == null ? null : v >= 0 ? "good" : "bad";
