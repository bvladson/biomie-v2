import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  fetchIntegrity,
  manageBackfill,
  resolveIntegrityIssue,
  runIntegrityChecks,
  syncOmieTxStep,
} from "@/lib/integrations.functions";

const LABEL: Record<string, string> = {
  vendors: "Vendedores",
  customers: "Clientes",
  products: "Produtos",
  invoices: "Notas fiscais",
  orders: "Pedidos",
  receivables: "Contas a receber",
  settlements: "Liquidações",
  invoice_items: "Itens de nota",
};
const STATE_LABEL: Record<string, string> = {
  PENDING: "Pendente",
  SYNCING: "Sincronizando",
  RAW_COMPLETE: "RAW completo",
  CANONICAL_COMPLETE: "Canonical completo",
  GOLD_COMPLETE: "Gold completo",
  RECONCILING: "Reconciliando",
  READY: "Pronto",
  DEGRADED: "Degradado",
  ERROR: "Erro",
};
const stateVariant = (s: string) =>
  s === "READY"
    ? "default"
    : s === "ERROR"
      ? "destructive"
      : s === "DEGRADED"
        ? "destructive"
        : "secondary";
const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

/** Central de Integridade (admins). Silently hidden for users without admin access. */
export function IntegrityCenter({ company }: { company: string }) {
  const getFn = useServerFn(fetchIntegrity);
  const backfillFn = useServerFn(manageBackfill);
  const checksFn = useServerFn(runIntegrityChecks);
  const resolveFn = useServerFn(resolveIntegrityIssue);
  const txFn = useServerFn(syncOmieTxStep);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["integrity", company],
    queryFn: () => getFn({ data: { company } }),
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["integrity", company] });
  const [entity, setEntity] = useState<"invoices" | "orders" | "receivables">("invoices");
  const [from, setFrom] = useState("2024-01-01");
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(true);

  if (q.isError) return null;
  if (!q.data)
    return <p className="text-sm text-muted-foreground">Carregando Central de Integridade…</p>;
  const { readiness, backfills, issues, runs } = q.data;
  const shownIssues = onlyOpen
    ? issues.filter((i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED")
    : issues;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const syncPeriod = (e: "invoices" | "orders" | "receivables" | "settlements") =>
    act(async () => {
      let runId: string | undefined;
      for (let i = 0; i < 200; i++) {
        const r = await txFn({
          data: { company, entity: e, from, to, ...(runId ? { runId } : {}) },
        });
        runId = r.runId;
        if (r.done) {
          if (r.status === "FAILED") throw new Error(r.message ?? "Falha na sincronização.");
          return;
        }
      }
    }, `${LABEL[e]}: período sincronizado.`);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Central de Integridade — prontidão por entidade</CardTitle>
          <CardDescription>
            "Pronto" exige RAW completo (comprovado pela paginação), Canonical, Gold, reconciliação
            sem divergência grave e atualização nas últimas 36 horas. Um sucesso antigo não conta
            como pronto.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Entidade</th>
                <th>Estado</th>
                <th>Período</th>
                <th className="text-right">Esperado</th>
                <th className="text-right">Recebido</th>
                <th className="text-right">Falhas</th>
                <th className="text-right">Divergências</th>
                <th>Última execução</th>
              </tr>
            </thead>
            <tbody>
              {readiness.map((r) => (
                <tr key={r.entity} className="border-t">
                  <td className="py-2 font-medium">{LABEL[r.entity] ?? r.entity}</td>
                  <td>
                    <Badge variant={stateVariant(r.state)}>{STATE_LABEL[r.state] ?? r.state}</Badge>
                  </td>
                  <td className="text-xs">
                    {r.periodFrom ? `${r.periodFrom} → ${r.periodTo}` : "Completo"}
                  </td>
                  <td className="text-right tabular-nums">{r.expected ?? "—"}</td>
                  <td className="text-right tabular-nums">{r.received ?? "—"}</td>
                  <td className="text-right tabular-nums">{r.failed ?? "—"}</td>
                  <td className="text-right tabular-nums">{r.openIssues}</td>
                  <td className="text-xs">
                    {fmt(r.finishedAt ?? r.lastRunAt)}
                    {r.message ? (
                      <div className="max-w-xs text-muted-foreground">{r.message}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notas, pedidos e financeiro — carga por período</CardTitle>
          <CardDescription>
            Escolha um intervalo. O período é dividido em meses com ponto de retomada. Exige
            cadastros já sincronizados. Campos do Omie ainda não confirmados com a API real.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">
              Entidade
              <select
                className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm"
                value={entity}
                onChange={(e) => setEntity(e.target.value as typeof entity)}
              >
                <option value="invoices">Notas fiscais</option>
                <option value="orders">Pedidos</option>
                <option value="receivables">Contas a receber</option>
              </select>
            </label>
            <label className="text-xs">
              De
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 w-40"
              />
            </label>
            <label className="text-xs">
              Até
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 w-40"
              />
            </label>
            <Button disabled={busy} onClick={() => syncPeriod(entity)}>
              Sincronizar agora
            </Button>
            <Button disabled={busy} variant="outline" onClick={() => syncPeriod("settlements")}>
              Sincronizar liquidações
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() =>
                act(
                  () => backfillFn({ data: { company, action: "create", entity, from, to } }),
                  "Backfill agendado.",
                )
              }
            >
              Agendar backfill
            </Button>
          </div>
          {backfills.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2">Entidade</th>
                  <th>Período</th>
                  <th>Status</th>
                  <th>Meses</th>
                  <th>Erro</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backfills.map((b) => (
                  <tr key={b.id} className="border-t">
                    <td className="py-2">{LABEL[b.entity]}</td>
                    <td className="text-xs">
                      {b.period_from} → {b.period_to}
                    </td>
                    <td>
                      <Badge variant="outline">{b.status}</Badge>
                    </td>
                    <td className="tabular-nums">
                      {b.partitions_done}/{b.partitions_total}
                    </td>
                    <td className="max-w-xs text-xs text-destructive">{b.last_error ?? ""}</td>
                    <td className="space-x-1 text-right">
                      {(["pause", "resume", "retry", "cancel"] as const).map((a) => (
                        <Button
                          key={a}
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            act(
                              () => backfillFn({ data: { company, action: a, jobId: b.id } }),
                              "Atualizado.",
                            )
                          }
                        >
                          {
                            {
                              pause: "Pausar",
                              resume: "Retomar",
                              retry: "Repetir",
                              cancel: "Cancelar",
                            }[a]
                          }
                        </Button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">Nenhum backfill agendado.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Divergências</CardTitle>
            <CardDescription>
              Registradas e mostradas, nunca ajustadas automaticamente. Toda decisão exige
              justificativa e vai para a auditoria.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setOnlyOpen(!onlyOpen)}>
              {onlyOpen ? "Ver todas" : "Só abertas"}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => act(() => checksFn({ data: { company } }), "Checagens executadas.")}
            >
              Executar checagens
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {shownIssues.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma divergência {onlyOpen ? "aberta" : "registrada"}.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2">Severidade</th>
                  <th>Entidade</th>
                  <th>ID externo</th>
                  <th>Motivo</th>
                  <th>Primeira / última</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownIssues.map((i) => (
                  <tr key={i.id} className="border-t align-top">
                    <td className="py-2">
                      <Badge
                        variant={
                          i.severity === "HIGH" || i.severity === "CRITICAL"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {i.severity}
                      </Badge>
                    </td>
                    <td>{LABEL[i.entity] ?? i.entity}</td>
                    <td className="font-mono text-xs">{i.external_id ?? "—"}</td>
                    <td>
                      {i.reason}
                      {i.justification ? (
                        <div className="text-xs text-muted-foreground">{i.justification}</div>
                      ) : null}
                    </td>
                    <td className="text-xs">
                      {fmt(i.first_seen_at)}
                      <br />
                      {fmt(i.last_seen_at)} ({i.occurrences}x)
                    </td>
                    <td>
                      <Badge variant="outline">{i.status}</Badge>
                    </td>
                    <td className="space-x-1 whitespace-nowrap text-right">
                      {(["ACKNOWLEDGED", "RESOLVED", "IGNORED"] as const).map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            const j = window.prompt("Justificativa (obrigatória):");
                            if (!j) return;
                            void act(
                              () =>
                                resolveFn({ data: { issueId: i.id, status: s, justification: j } }),
                              "Decisão registrada.",
                            );
                          }}
                        >
                          {{ ACKNOWLEDGED: "Ciente", RESOLVED: "Resolver", IGNORED: "Ignorar" }[s]}
                        </Button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Últimas sincronizações Omie</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma sincronização executada nesta empresa.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2">Entidade</th>
                  <th>Modo</th>
                  <th>Status</th>
                  <th>Início</th>
                  <th className="text-right">Duração</th>
                  <th className="text-right">Registros</th>
                  <th className="text-right">Falhas</th>
                  <th>Mensagem</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-2">{LABEL[r.entity] ?? r.entity}</td>
                    <td className="text-xs">{r.mode}</td>
                    <td>
                      <Badge variant={r.status === "FAILED" ? "destructive" : "outline"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="text-xs">{fmt(r.started_at)}</td>
                    <td className="text-right tabular-nums">
                      {r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : "—"}
                    </td>
                    <td className="text-right tabular-nums">{r.received}</td>
                    <td className="text-right tabular-nums">{r.failed}</td>
                    <td className="max-w-xs text-xs text-muted-foreground">{r.message ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
