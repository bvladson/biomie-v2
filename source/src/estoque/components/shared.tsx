import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, PackageOpen } from "lucide-react";
import type { Curve, StockReading } from "../api/contract";
import { dateTime, errorMessage } from "../lib/format";
const curveLabel = (c: Curve) => (c === "U" ? "Sem curva" : `Curva ${c}`);
/** Classes completas (o Tailwind só gera as que aparecem escritas): cores em styles.css. */
const CURVE_DOT: Record<Curve, string> = {
  A: "bg-curve-a",
  B: "bg-curve-b",
  C: "bg-curve-c",
  D: "bg-curve-d",
  U: "bg-curve-u",
};
export function CurveBadge({ curve }: { curve: Curve }) {
  return (
    <Badge variant="outline" className="gap-2 whitespace-nowrap text-foreground">
      <span aria-hidden className={`size-2 rounded-full ${CURVE_DOT[curve]}`} />
      {curveLabel(curve)}
    </Badge>
  );
}
export function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="h-11 w-full bg-card">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function Metric({ label, value, foot }: { label: string; value: string; foot?: string }) {
  return (
    <article className="min-w-0 rounded-lg border bg-card p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-3 break-words text-2xl font-semibold tabular-nums">{value}</p>
      {foot && <p className="mt-2 text-xs text-muted-foreground">{foot}</p>}
    </article>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-md border bg-muted p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
export function Status({
  loading,
  error,
  empty,
  retry,
}: {
  loading?: boolean | undefined;
  error?: unknown;
  empty?: boolean | undefined;
  retry: () => void;
}) {
  if (loading)
    return (
      <div aria-label="Carregando estoque" aria-busy="true" className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  if (error)
    return (
      <div role="alert" className="space-y-4 py-10">
        <p>{errorMessage(error)}</p>
        <Button variant="outline" onClick={retry}>
          Tentar de novo
        </Button>
      </div>
    );
  if (empty)
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <PackageOpen className="size-10 text-muted-foreground" aria-hidden />
        <h2 className="text-lg font-medium">A primeira leitura do estoque ainda não terminou</h2>
      </div>
    );
  return null;
}
export function Readings({
  readings,
  refresh,
}: {
  readings: StockReading[];
  refresh?: ((id: string) => void) | undefined;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Últimas leituras</h2>
      <div className="divide-y border-y">
        {readings.map((r) => (
          <div key={r.companyId} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">{r.companyName}</p>
              <p className="text-xs text-muted-foreground">
                {dateTime(r.readAt)} · Brasília · {r.positions} posições
              </p>
              {r.status === "failed" && r.lastError && (
                <p className="mt-1 break-words text-xs text-destructive">
                  Última tentativa: {r.lastError}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {r.inProgress && <Badge variant="secondary">Leitura em andamento</Badge>}
              <Badge variant="outline">
                {r.status === "ok"
                  ? "Leitura completa"
                  : r.status === "stale"
                    ? "Dado antigo · +6h"
                    : r.status === "failed"
                      ? "Falha na última leitura"
                      : "Aguardando a primeira leitura"}
              </Badge>
              {refresh && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={r.inProgress === true}
                  onClick={() => refresh(r.companyId)}
                >
                  Solicitar leitura
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
