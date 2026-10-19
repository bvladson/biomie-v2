import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDelta, formatValue } from "@/domain/format";
import { delta } from "@/domain/metrics/compute";
import type { AnalyticsQuery } from "@/domain/filters";
import { vendorFlightPlanQuery } from "@/lib/queries";
import { saveCommit } from "@/lib/flight-plan.functions";
import { FlightPlanChart } from "./FlightPlanChart";
import { ActionsPanel } from "./ActionsPanel";
import { FpKpi, StatusBadge, signTone } from "./parts";

export function VendorDrawer({
  q,
  seller,
  onClose,
  canWrite,
}: {
  q: AnalyticsQuery;
  seller: string | undefined;
  onClose: () => void;
  canWrite: boolean;
}) {
  return (
    <Sheet open={!!seller} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        {seller && <VendorBody q={q} seller={seller} canWrite={canWrite} />}
      </SheetContent>
    </Sheet>
  );
}

function VendorBody({
  q,
  seller,
  canWrite,
}: {
  q: AnalyticsQuery;
  seller: string;
  canWrite: boolean;
}) {
  const { data, isPending, error } = useQuery(vendorFlightPlanQuery({ ...q, seller }));
  const v = data?.vendors[0];

  if (error) return <p className="p-6 text-sm text-muted-foreground">{error.message}</p>;
  if (isPending || !data)
    return (
      <div className="space-y-4 p-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!v)
    return (
      <p className="p-6 text-sm text-muted-foreground">Vendedor não encontrado ou sem acesso.</p>
    );
  const m = v.metrics;
  const sameCut = data.period.state === "current";

  return (
    <div className="flex flex-col gap-5">
      <SheetHeader className="p-0">
        <div className="flex items-center gap-2">
          <SheetTitle className="text-xl">{v.name}</SheetTitle>
          <StatusBadge status={m.status} />
        </div>
        <SheetDescription>
          Plano de Voo individual · {m.workingDaysElapsed} de {m.workingDaysTotal} dias úteis
        </SheetDescription>
      </SheetHeader>

      <section className="panel grid grid-cols-2 divide-border sm:grid-cols-4">
        <FpKpi metricKey="revenue" label="Realizado" value={m.realized} />
        <FpKpi metricKey="target" label="Meta ativa" value={m.target} />
        <FpKpi metricKey="target_attainment" value={m.attainment} />
        <FpKpi metricKey="ideal_today" value={m.idealToday} />
        <FpKpi metricKey="deviation" value={m.deviation} tone={signTone(m.deviation)} />
        <FpKpi metricKey="remaining_gap" value={m.remainingGap} />
        <FpKpi
          metricKey="working_days"
          label="Dias úteis restantes"
          value={m.workingDaysRemaining}
        />
        <FpKpi
          metricKey="required_daily_pace"
          value={m.requiredDailyPace}
          sub={m.gapUnreachable ? "Sem dias restantes" : undefined}
        />
        <FpKpi metricKey="current_daily_pace" value={m.currentDailyPace} />
        <FpKpi metricKey="forecast_probable" value={m.forecastProbable} />
        <FpKpi metricKey="portfolio" value={m.portfolio} sub={`${v.orders} pedidos`} />
        <FpKpi metricKey="gap_coverage" value={m.gapCoverage} sub="não é garantia de meta" />
      </section>

      <section className="panel p-4">
        <h3 className="mb-3 text-sm font-semibold">Evolução diária</h3>
        <FlightPlanChart
          timeline={data.timeline}
          target={m.target}
          today={data.period.today}
          height={260}
        />
      </section>

      <section className="panel p-4">
        <h3 className="mb-1 text-sm font-semibold">Comparações</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {sameCut ? "Mês anterior e ano anterior até o mesmo dia do mês." : "Meses completos."}
        </p>
        <div className="grid grid-cols-3 gap-3 text-sm">
          {(
            [
              ["Mês anterior", v.comparisons.previousMonth],
              ["Mesmo mês ano anterior", v.comparisons.previousYear],
              ["Média últimos 3 meses", v.comparisons.last3Avg],
            ] as const
          ).map(([label, val]) => {
            const d = delta(m.realized, val);
            return (
              <div key={label} className="rounded-md border p-3">
                <div className="eyebrow">{label}</div>
                <div className="mt-1 font-semibold tabular">{formatValue(val, "currency")}</div>
                <div
                  className={
                    d == null
                      ? "text-xs text-muted-foreground"
                      : d >= 0
                        ? "text-xs text-success"
                        : "text-xs text-destructive"
                  }
                >
                  {d == null ? "—" : `${d >= 0 ? "▲" : "▼"} ${formatDelta(d)} realizado atual`}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Média dos últimos 3 meses usa meses completos.
        </p>
      </section>

      <CommitForm
        q={q}
        seller={seller}
        current={m.forecastCommit}
        note={v.commitNote}
        canWrite={canWrite && data.period.state !== "closed"}
      />

      <section className="panel">
        <h3 className="border-b px-4 py-3 text-sm font-semibold">Ações prioritárias</h3>
        <ActionsPanel
          actions={data.actions}
          company={q.company}
          period={q.period}
          canWrite={canWrite}
        />
      </section>

      <section className="flex flex-wrap gap-2">
        <span className="w-full text-xs text-muted-foreground">
          Detalhar (empresa, período e filtros preservados):
        </span>
        <Button asChild size="sm">
          <Link
            to="/vendedores/$sellerId"
            params={{ sellerId: seller }}
            search={
              ((p: Record<string, unknown>) => ({
                ...p,
                vendor: undefined,
                q: undefined,
                st: undefined,
              })) as never
            }
          >
            Abrir Vendedor 360
          </Link>
        </Button>
        {(
          [
            ["Faturamento", { tab: "resumo", dim: "seller" }],
            ["Clientes", { tab: "resumo", dim: "customer" }],
            ["Produtos", { tab: "resumo", dim: "product" }],
          ] as const
        ).map(([label, extra]) => (
          <Button key={label} asChild size="sm" variant="outline">
            <Link
              to="/vendas"
              search={
                ((p: Record<string, unknown>) => ({
                  ...p,
                  seller,
                  vendor: undefined,
                  q: undefined,
                  st: undefined,
                  ...extra,
                })) as never
              }
            >
              {label}
            </Link>
          </Button>
        ))}
      </section>
    </div>
  );
}

function CommitForm({
  q,
  seller,
  current,
  note,
  canWrite,
}: {
  q: AnalyticsQuery;
  seller: string;
  current: number | null;
  note: string | null;
  canWrite: boolean;
}) {
  const [amount, setAmount] = useState(current?.toString() ?? "");
  const [text, setText] = useState(note ?? "");
  useEffect(() => {
    setAmount(current?.toString() ?? "");
    setText(note ?? "");
  }, [current, note]);
  const qc = useQueryClient();
  const fn = useServerFn(saveCommit);
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          company: q.company,
          seller,
          period: q.period,
          amount: Number(amount),
          note: text || undefined,
        },
      }),
    onSuccess: async () => {
      toast.success("Commit registrado");
      await qc.invalidateQueries({ queryKey: ["flight-plan"] });
      await qc.invalidateQueries({ queryKey: ["flight-plan-vendor"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });
  const valid = amount !== "" && Number.isFinite(Number(amount)) && Number(amount) >= 0;

  return (
    <section className="panel p-4">
      <h3 className="text-sm font-semibold">Commit</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Previsão assumida manualmente. Não é calculada pelo sistema.
      </p>
      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) mut.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="commit-amount" className="text-xs">
              Valor (R$)
            </Label>
            <Input
              id="commit-amount"
              inputMode="decimal"
              type="number"
              min={0}
              step="100"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-8 w-40"
            />
          </div>
          <div className="grid flex-1 gap-1">
            <Label htmlFor="commit-note" className="text-xs">
              Observação
            </Label>
            <Input
              id="commit-note"
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-8"
            />
          </div>
          <Button type="submit" size="sm" disabled={!valid || mut.isPending}>
            Salvar
          </Button>
        </form>
      ) : (
        <p className="text-sm">
          {current != null ? formatValue(current, "currency") : "Nenhum commit registrado."}
        </p>
      )}
    </section>
  );
}
