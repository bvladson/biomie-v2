import type { ReactNode } from "react";
import { AlertTriangle, Info, Loader2, RefreshCw } from "lucide-react";
import type { FlightStatus } from "../api/contract";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DEFINITIONS, type MetricKey } from "../lib/definitions";

const STATUS: Record<FlightStatus, { icon: string; label: string; cls: string }> = {
  ON_TRACK: { icon: "▲", label: "No plano", cls: "text-success border-success/30 bg-success/10" },
  ATTENTION: { icon: "●", label: "Atenção", cls: "text-warning border-warning/30 bg-warning/10" },
  RISK: { icon: "▼", label: "Em risco", cls: "text-risk border-risk/30 bg-risk/10" },
  CRITICAL: {
    icon: "✖",
    label: "Crítico",
    cls: "text-destructive border-destructive/30 bg-destructive/10",
  },
};
export const statusText = (s: FlightStatus | null) =>
  s ? `${STATUS[s].icon} ${STATUS[s].label}` : "Sem meta";

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
          "inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-xs text-muted-foreground",
          className,
        )}
      >
        — Sem meta
      </span>
    );
  const s = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-semibold",
        s.cls,
        className,
      )}
    >
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

export function InfoTip({ metric }: { metric: MetricKey }) {
  const d = DEFINITIONS[metric];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`O que é ${d.title}`}
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm">
        <p className="font-semibold">{d.title}</p>
        <p className="mt-1 text-muted-foreground">{d.text}</p>
        <p className="mt-2 rounded bg-muted px-2 py-1 text-xs">Fórmula: {d.formula}</p>
      </PopoverContent>
    </Popover>
  );
}

export function Panel({
  title,
  action,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn("min-w-0 rounded-lg border bg-card p-4 md:p-5", className)}
      aria-label={typeof title === "string" ? title : undefined}
    >
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  metric,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  metric?: MetricKey;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {label}
        {metric && <InfoTip metric={metric} />}
      </div>
      <div
        className={cn(
          "fp-num mt-1 truncate text-xl font-semibold",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Loading({ label = "Carregando o plano…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {label}
      </span>
      <div className="grid gap-3 md:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-5"
    >
      <p className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="size-4" aria-hidden />
        Não foi possível carregar.
      </p>
      <p className="text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "Erro desconhecido."}
      </p>
      <Button variant="outline" size="sm" onClick={retry}>
        <RefreshCw className="size-4" aria-hidden />
        Tentar novamente
      </Button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed bg-card p-6 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function TableWrap({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      className="w-full overflow-x-auto rounded-md border"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className="w-full min-w-max text-sm">{children}</table>
    </div>
  );
}
export const th =
  "bg-muted px-3 py-2 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap";
export const thR = th + " text-right";
export const td = "border-t px-3 py-2 whitespace-nowrap";
export const tdR = td + " text-right fp-num";
