import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, CheckCircle2, CircleAlert, CircleX, Play } from "lucide-react";
import { toast } from "sonner";
import { useGlobalFilters } from "@/hooks/use-filters";
import { pageHead, PageSkeleton, Panel } from "@/components/entities/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatValue } from "@/domain/format";
import {
  fetchFreshness,
  fetchHealth,
  fetchQualityJobs,
  fetchReconciliation,
  triggerReconciliation,
} from "@/lib/quality.functions";
import type {
  FreshnessStatus,
  HealthStatus,
  ReconciliationResult,
} from "@/lib/repositories/quality.repository.server";
import { cn } from "@/lib/utils";
import { IntegrityCenter } from "@/components/integrations/IntegrityCenter";

const DESC = "Posso confiar nos números do BIOMIE? Atualização, reconciliação, jobs e saúde.";

export const Route = createFileRoute("/_authenticated/_shell/qualidade-dos-dados")({
  head: () => pageHead("Qualidade dos Dados", DESC),
  component: QualityPage,
});

const LAYERS = [
  { key: "SOURCE", label: "Origem", desc: "ERP (Omie) — sistema de registro" },
  { key: "RAW", label: "Raw", desc: "Payload bruto, sem transformação" },
  { key: "CANONICAL", label: "Canônico", desc: "Entidades BIOMIE normalizadas" },
  { key: "GOLD", label: "Gold", desc: "Fatos validados (fact_sales, títulos)" },
  { key: "MART", label: "Mart", desc: "Read models das telas" },
];

const FRESH_CLASS: Record<FreshnessStatus, string> = {
  FRESH: "border-success/40 text-success",
  WARNING: "border-warning/40 text-warning",
  STALE: "border-destructive/40 text-destructive",
  FAILED: "border-destructive bg-destructive/10 text-destructive",
};
const REC_CLASS: Record<ReconciliationResult["status"], string> = {
  OK: "border-success/40 text-success",
  WARNING: "border-warning/40 text-warning",
  FAILED: "border-destructive/40 text-destructive",
};
const HEALTH_ICON: Record<HealthStatus, React.ReactNode> = {
  ok: <CheckCircle2 className="size-4 text-success" />,
  warning: <CircleAlert className="size-4 text-warning" />,
  error: <CircleX className="size-4 text-destructive" />,
  not_configured: <CircleAlert className="size-4 text-muted-foreground" />,
};

const fmtTs = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

function QualityPage() {
  const { resolved, company } = useGlobalFilters();
  const qc = useQueryClient();
  const freshFn = useServerFn(fetchFreshness);
  const jobsFn = useServerFn(fetchQualityJobs);
  const recFn = useServerFn(fetchReconciliation);
  const runFn = useServerFn(triggerReconciliation);
  const healthFn = useServerFn(fetchHealth);
  const c = resolved?.company ?? "";
  const period = resolved?.period ?? "";
  const fresh = useQuery({
    queryKey: ["quality-fresh", c],
    queryFn: () => freshFn({ data: { company: c } }),
    enabled: !!c,
  });
  const jobs = useQuery({
    queryKey: ["quality-jobs", c],
    queryFn: () => jobsFn({ data: { company: c } }),
    enabled: !!c && !fresh.error,
  });
  const rec = useQuery({
    queryKey: ["quality-rec", c, period],
    queryFn: () => recFn({ data: { company: c, period } }),
    enabled: !!c && !fresh.error,
  });
  const health = useQuery({
    queryKey: ["quality-health", c],
    queryFn: () => healthFn({ data: { company: c } }),
    enabled: !!c && !fresh.error,
  });
  const run = useMutation({
    mutationFn: () => runFn({ data: { company: c, period } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quality-rec", c, period] });
      qc.invalidateQueries({ queryKey: ["quality-jobs", c] });
      toast.success("Reconciliação executada");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!resolved) return null;
  if (fresh.error)
    return (
      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Qualidade dos Dados</h1>
        <p className="mt-2 text-sm text-muted-foreground">{fresh.error.message}</p>
      </main>
    );
  if (fresh.isPending) return <PageSkeleton />;

  const f = fresh.data;
  const results = rec.data?.results ?? [];
  const failed = results.filter((r) => r.status === "FAILED").length;
  const warned = results.filter((r) => r.status === "WARNING").length;
  const notFresh = f.datasets.filter((d) => d.status !== "FRESH");
  const verdict = !rec.data?.run
    ? {
        tone: "warning",
        text: "Ainda sem reconciliação para este período — execute a verificação.",
      }
    : failed || notFresh.some((d) => d.status === "FAILED" || d.status === "STALE")
      ? {
          tone: "bad",
          text: `Atenção: ${failed} divergência(s) e ${notFresh.length} dataset(s) fora do prazo.`,
        }
      : warned || notFresh.length
        ? {
            tone: "warning",
            text: `Confiável com ressalvas: ${warned} alerta(s), ${notFresh.length} dataset(s) com atraso.`,
          }
        : {
            tone: "good",
            text: "Sim. Todos os datasets atualizados e todas as verificações batem.",
          };

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header>
        <p className="eyebrow">
          {company?.name} · referência {fmtTs(f.reference)}
          {f.isDemo && " · MODO DEMONSTRAÇÃO"}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Qualidade dos Dados</h1>
      </header>

      <section
        className={cn(
          "panel flex items-start gap-3 p-4",
          verdict.tone === "good" && "border-success/40",
          verdict.tone === "bad" && "border-destructive/50",
          verdict.tone === "warning" && "border-warning/50",
        )}
      >
        {verdict.tone === "good"
          ? HEALTH_ICON.ok
          : verdict.tone === "bad"
            ? HEALTH_ICON.error
            : HEALTH_ICON.warning}
        <div>
          <p className="text-sm font-semibold">Posso confiar nos números do BIOMIE?</p>
          <p className="text-sm text-muted-foreground">{verdict.text}</p>
        </div>
      </section>

      <Panel title="Pipeline de dados">
        <div className="flex flex-wrap items-stretch gap-2 p-4">
          {LAYERS.map((l, i) => (
            <div key={l.key} className="flex items-center gap-2">
              <div className="rounded-md border bg-surface px-3 py-2">
                <div className="font-mono text-xs font-semibold">{l.key}</div>
                <div className="text-xs text-muted-foreground">{l.desc}</div>
              </div>
              {i < LAYERS.length - 1 && <ArrowRight className="size-4 text-muted-foreground" />}
            </div>
          ))}
        </div>
        {f.isDemo && (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            No modo demonstração os dados foram carregados diretamente nas camadas Canônico/Gold; as
            datas de cada camada seguem o mesmo contrato que a integração Omie preencherá.
          </p>
        )}
      </Panel>

      <Panel
        title={`Atualização dos dados (alerta > ${f.warningHours}h, desatualizado > ${f.staleHours}h)`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Dataset</th>
                <th className="px-4 py-2 font-medium">Última sincronização</th>
                <th className="px-4 py-2 font-medium">Última transformação</th>
                <th className="px-4 py-2 font-medium">Mart atualizado</th>
                <th className="px-4 py-2 text-right font-medium">Registros</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {f.datasets.map((d) => (
                <tr key={d.dataset} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{d.label}</td>
                  <td className="px-4 py-2">{fmtTs(d.lastSync)}</td>
                  <td className="px-4 py-2">{fmtTs(d.lastTransform)}</td>
                  <td className="px-4 py-2">{fmtTs(d.martUpdated)}</td>
                  <td className="px-4 py-2 text-right tabular">
                    {formatValue(d.records, "integer")}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="outline" className={cn("font-normal", FRESH_CLASS[d.status])}>
                      {d.status}
                    </Badge>
                    {d.error && <span className="ml-2 text-xs text-destructive">{d.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={`Reconciliação · ${period}`}
        actions={
          <Button size="sm" variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
            <Play className="size-3.5" /> {run.isPending ? "Executando…" : "Executar agora"}
          </Button>
        }
      >
        {rec.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : rec.error ? (
          <p className="p-4 text-sm text-muted-foreground">{rec.error.message}</p>
        ) : !rec.data.run ? (
          <p className="p-4 text-sm text-muted-foreground">Nenhuma execução para este período.</p>
        ) : (
          <div className="overflow-x-auto">
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              Executada em {fmtTs(rec.data.run.startedAt)}. Divergências nunca são ajustadas para
              bater — aparecem como estão.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Verificação</th>
                  <th className="px-4 py-2 text-right font-medium">Origem</th>
                  <th className="px-4 py-2 text-right font-medium">Destino</th>
                  <th className="px-4 py-2 text-right font-medium">Diferença</th>
                  <th className="px-4 py-2 text-right font-medium">%</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium">{r.check_name}</div>
                      <div className="max-w-md text-xs text-muted-foreground">{r.rule}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular">
                      {formatValue(r.source_value, "currency")}
                      {r.source_count != null && (
                        <div className="text-xs text-muted-foreground">{r.source_count} reg.</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular">
                      {formatValue(r.target_value, "currency")}
                      {r.target_count != null && (
                        <div className="text-xs text-muted-foreground">{r.target_count} reg.</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular">
                      {formatValue(r.abs_diff, "currency")}
                    </td>
                    <td className="px-4 py-2 text-right tabular">
                      {formatValue(r.pct_diff, "percent")}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant="outline" className={cn("font-normal", REC_CLASS[r.status])}>
                        {r.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Saúde do sistema">
          {health.isPending ? (
            <Skeleton className="m-4 h-40" />
          ) : health.error ? (
            <p className="p-4 text-sm text-muted-foreground">{health.error.message}</p>
          ) : (
            <ul className="divide-y">
              {health.data.map((h) => (
                <li key={h.key} className="flex items-start gap-3 px-4 py-3">
                  {HEALTH_ICON[h.status]}
                  <div>
                    <div className="text-sm font-medium">{h.label}</div>
                    <div className="text-xs text-muted-foreground">{h.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Execuções de jobs">
          {jobs.isPending ? (
            <Skeleton className="m-4 h-40" />
          ) : jobs.error ? (
            <p className="p-4 text-sm text-muted-foreground">{jobs.error.message}</p>
          ) : (
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Job</th>
                    <th className="px-4 py-2 font-medium">Início</th>
                    <th className="px-4 py-2 font-medium">Fim</th>
                    <th className="px-4 py-2 text-right font-medium">Duração</th>
                    <th className="px-4 py-2 text-right font-medium">Registros</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.map((j) => (
                    <tr key={j.id} className="border-b align-top last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{j.job}</div>
                        <div className="text-xs text-muted-foreground">
                          {j.company ? company?.name : "Todas as empresas"} · {j.trigger}
                        </div>
                      </td>
                      <td className="px-4 py-2">{fmtTs(j.startedAt)}</td>
                      <td className="px-4 py-2">{fmtTs(j.finishedAt)}</td>
                      <td className="px-4 py-2 text-right tabular">
                        {j.durationMs == null ? "—" : `${(j.durationMs / 1000).toFixed(1)} s`}
                      </td>
                      <td className="px-4 py-2 text-right tabular">{j.rows}</td>
                      <td className="px-4 py-2">
                        <span className={j.status === "failed" ? "text-destructive" : undefined}>
                          {j.status}
                        </span>
                        {j.error && <div className="text-xs text-muted-foreground">{j.error}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
      {c ? <IntegrityCenter company={c} /> : null}
    </main>
  );
}
