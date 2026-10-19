import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { useGlobalFilters } from "@/hooks/use-filters";
import { IntegrityCenter } from "@/components/integrations/IntegrityCenter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  controlWorker,
  fetchIntegrationOverview,
  fetchOmieComparison,
  fetchWorkerStatus,
  resolveOmieMatch,
  saveOmieCredentials,
  setDataSource,
  syncOmieStep,
  testOmie,
  type MigrationRow,
} from "@/lib/integrations.functions";

export const Route = createFileRoute("/_authenticated/_shell/integracoes")({
  head: () => ({
    meta: [
      { title: "Integrações — BIOMIE" },
      {
        name: "description",
        content: "Conexão com o Omie, sincronização, migração e comparação de cadastros.",
      },
      { property: "og:title", content: "Integrações — BIOMIE" },
      {
        property: "og:description",
        content: "Conexão com o Omie, sincronização, migração e comparação de cadastros.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: IntegrationsPage,
});

type Entity = "vendors" | "customers" | "products";
const ENTITY_LABEL: Record<Entity, string> = {
  vendors: "Vendedores",
  customers: "Clientes",
  products: "Produtos",
};
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("pt-BR") : "—");

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (["CONNECTED", "SUCCESS", "READY", "MATCHED", "MANUAL"].includes(s)) return "default";
  if (["ERROR", "FAILED", "CONFLICT", "INVALID_CREDENTIALS"].includes(s)) return "destructive";
  if (["RUNNING", "WARNING"].includes(s)) return "secondary";
  return "outline";
}

function IntegrationsPage() {
  const { resolved, companyInfo } = useGlobalFilters() as ReturnType<typeof useGlobalFilters> & {
    companyInfo?: { name?: string };
  };
  const company = resolved?.company ?? null;
  const getOverview = useServerFn(fetchIntegrationOverview);
  const qc = useQueryClient();
  const overview = useQuery({
    queryKey: ["integrations", company],
    queryFn: () => getOverview({ data: { company: company! } }),
    enabled: !!company,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations", company] });

  if (!company) return <p className="p-6 text-muted-foreground">Nenhuma empresa disponível.</p>;
  if (overview.isError)
    return <p className="p-6 text-destructive">{(overview.error as Error).message}</p>;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Integrações</h1>
        <p className="text-sm text-muted-foreground">
          Omie em modo sombra: os dados entram em RAW e Canonical e são comparados ao BIOMIE. As
          telas continuam usando a fonte atual até a ativação.
          {companyInfo?.name ? ` Empresa: ${companyInfo.name}.` : ""}
        </p>
      </header>
      {overview.isLoading || !overview.data ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <>
          <WorkerStatusCard />
          <div className="grid gap-6 lg:grid-cols-2">
            <ConnectionCard company={company} data={overview.data} onChange={refresh} />
            <DataSourceCard
              company={company}
              current={overview.data.dataSource}
              onChange={refresh}
            />
          </div>
          <MigrationPanel company={company} rows={overview.data.migration} onChange={refresh} />
          <ComparisonPanel company={company} />
          <IntegrityCenter company={company} />
        </>
      )}
    </div>
  );
}

type Overview = Awaited<ReturnType<typeof fetchIntegrationOverview>>;

const WORKER_STATE_LABEL: Record<string, string> = {
  RUNNING: "Processando",
  IDLE: "Ocioso",
  PAUSED: "Pausado",
  THROTTLED: "Aguardando a máquina aliviar",
  BLACKOUT: "Janela bloqueada",
  ERROR: "Erro no último ciclo",
};

/** Worker owns every Omie load; SUPER_ADMIN can pause/resume it here. */
function WorkerStatusCard() {
  const getStatus = useServerFn(fetchWorkerStatus);
  const control = useServerFn(controlWorker);
  const status = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => getStatus(),
    refetchInterval: 30_000,
  });
  const [busy, setBusy] = useState(false);
  if (!status.data) return null;
  const w = status.data;
  const heartbeat = w.heartbeatAt;
  const stale = !heartbeat || Date.now() - new Date(heartbeat).getTime() > 5 * 60_000;
  const state = stale ? "SEM SINAL" : (w.state ?? "—");
  const act = async (action: "pause" | "resume") => {
    setBusy(true);
    try {
      await control({ data: { action } });
      toast.success(action === "pause" ? "Worker pausado." : "Worker retomado.");
      await status.refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-4 w-4" /> Worker de integração
          <Badge variant={stale || state === "ERROR" ? "destructive" : "outline"}>
            {WORKER_STATE_LABEL[state] ?? state}
          </Badge>
          {w.recurring && <Badge variant="secondary">Recorrência ligada</Badge>}
        </CardTitle>
        <CardDescription>
          Todas as cargas do Omie rodam no worker, com limite de chamadas e pausa automática quando
          a máquina está carregada. Último sinal: {fmtDate(heartbeat)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act(w.paused ? "resume" : "pause")}
        >
          {w.paused ? "Retomar" : "Pausar"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ConnectionCard({
  company,
  data,
  onChange,
}: {
  company: string;
  data: Overview;
  onChange: () => void;
}) {
  const save = useServerFn(saveOmieCredentials);
  const test = useServerFn(testOmie);
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const i = data.integration;

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    try {
      await save({ data: { company, appKey, appSecret } });
      setAppKey("");
      setAppSecret("");
      toast.success("Credenciais salvas com segurança.");
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const onTest = async () => {
    setBusy("test");
    try {
      const r = await test({ data: { company } });
      (r.ok ? toast.success : toast.error)(r.message);
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="h-4 w-4" /> Omie
          <Badge variant={statusVariant(i?.status ?? "")}>{i?.status ?? "NÃO CONFIGURADO"}</Badge>
        </CardTitle>
        <CardDescription>
          {i?.appKeyHint ? `Chave cadastrada: ${i.appKeyHint}` : "Nenhuma credencial cadastrada."}{" "}
          Os valores nunca são exibidos novamente.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSave} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="app-key">App Key</Label>
            <Input
              id="app-key"
              autoComplete="off"
              value={appKey}
              onChange={(e) => setAppKey(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="app-secret">App Secret</Label>
            <Input
              id="app-secret"
              type="password"
              autoComplete="new-password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!appKey || !appSecret || busy !== null}>
              {busy === "save"
                ? "Salvando…"
                : i?.appKeyHint
                  ? "Substituir credenciais"
                  : "Salvar credenciais"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onTest}
              disabled={!i?.appKeyHint || busy !== null}
            >
              {busy === "test" ? "Testando…" : "Testar conexão"}
            </Button>
          </div>
        </form>
        {i?.lastTestAt && (
          <p className={`text-sm ${i.lastTestOk ? "text-muted-foreground" : "text-destructive"}`}>
            Último teste ({fmtDate(i.lastTestAt)}): {i.lastTestMessage}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DataSourceCard({
  company,
  current,
  onChange,
}: {
  company: string;
  current: string;
  onChange: () => void;
}) {
  const change = useServerFn(setDataSource);
  const [source, setSource] = useState(current);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const onApply = async () => {
    setBusy(true);
    try {
      await change({ data: { company, source: source as "DEMO", confirmation } });
      toast.success("Fonte de dados alterada.");
      setConfirmation("");
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Fonte de dados
          <Badge variant="outline">{current}</Badge>
        </CardTitle>
        <CardDescription>
          DEMO: dados de demonstração. OMIE_SHADOW: sincroniza e compara sem mudar as telas. OMIE:
          exige Super Admin, todas as entidades prontas e a frase "ATIVAR OMIE".
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger aria-label="Fonte de dados">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DEMO">DEMO</SelectItem>
            <SelectItem value="OMIE_SHADOW">OMIE_SHADOW</SelectItem>
            <SelectItem value="OMIE">OMIE</SelectItem>
          </SelectContent>
        </Select>
        {source === "OMIE" && (
          <Input
            placeholder='Digite "ATIVAR OMIE"'
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        )}
        <Button onClick={onApply} disabled={busy || source === current}>
          {busy ? "Aplicando…" : "Aplicar"}
        </Button>
      </CardContent>
    </Card>
  );
}

function MigrationPanel({
  company,
  rows,
  onChange,
}: {
  company: string;
  rows: MigrationRow[];
  onChange: () => void;
}) {
  const step = useServerFn(syncOmieStep);
  const [running, setRunning] = useState<{ entity: string; text: string } | null>(null);

  const runSync = async (entity: Entity, resumeId?: string) => {
    let runId = resumeId;
    setRunning({ entity, text: "Iniciando…" });
    try {
      for (;;) {
        const r = await step({ data: { company, entity, runId } });
        runId = r.runId;
        setRunning({
          entity,
          text: `${r.pagesDone}${r.pagesTotal ? `/${r.pagesTotal}` : ""} páginas · ${r.received} registros`,
        });
        if (r.done) {
          (r.status === "FAILED"
            ? toast.error
            : r.status === "WARNING"
              ? toast.warning
              : toast.success)(r.message ?? `${ENTITY_LABEL[entity]} sincronizados.`);
          break;
        }
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRunning(null);
      onChange();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Migração</CardTitle>
        <CardDescription>
          Ordem obrigatória: Vendedores → Clientes → Produtos. Nada é apagado; registros que somem
          do Omie ficam marcados.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2">Entidade</th>
              <th>RAW</th>
              <th>Canonical</th>
              <th>Gold</th>
              <th>Reconciliação</th>
              <th>Última sincronização</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const entity = r.entity as Entity;
              const isRunning = running?.entity === r.entity;
              const failed = r.lastRun && ["FAILED", "RUNNING"].includes(r.lastRun.status);
              return (
                <tr key={r.entity} className="border-b last:border-0 align-top">
                  <td className="py-2 font-medium">{r.label}</td>
                  <td className="tabular-nums">{r.raw.toLocaleString("pt-BR")}</td>
                  <td className="tabular-nums">
                    {r.canonical.toLocaleString("pt-BR")}
                    {r.missingInSource > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        {r.missingInSource} ausentes no Omie
                      </span>
                    )}
                  </td>
                  <td className="tabular-nums">{r.gold}</td>
                  <td className="text-xs">
                    {r.enabled ? (
                      <>
                        {r.matched} ok · {r.conflicts} conflitos · {r.unmatched} sem par ·{" "}
                        {r.duplicates} duplic.
                      </>
                    ) : (
                      "Aguardando aprovação"
                    )}
                  </td>
                  <td className="text-xs">
                    {isRunning ? (
                      running.text
                    ) : r.lastRun ? (
                      <>
                        {fmtDate(r.lastRun.startedAt)}
                        {r.lastRun.durationMs != null &&
                          ` · ${Math.round(r.lastRun.durationMs / 1000)}s`}
                        {r.lastRun.message && (
                          <span className="block text-muted-foreground">{r.lastRun.message}</span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </td>
                  <td className="text-right">
                    {r.enabled && (
                      <div className="flex justify-end gap-1">
                        {failed && r.lastRun && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!running}
                            onClick={() => runSync(entity, r.lastRun!.id)}
                          >
                            Retomar
                          </Button>
                        )}
                        <Button size="sm" disabled={!!running} onClick={() => runSync(entity)}>
                          <RefreshCw
                            className={`mr-1 h-3 w-3 ${isRunning ? "animate-spin" : ""}`}
                          />
                          Sincronizar
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function ComparisonPanel({ company }: { company: string }) {
  const [entity, setEntity] = useState<Entity>("vendors");
  const [filter, setFilter] = useState<string>("pending");
  const get = useServerFn(fetchOmieComparison);
  const resolve = useServerFn(resolveOmieMatch);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["omie-comparison", company, entity],
    queryFn: () => get({ data: { company, entity } }),
  });
  const rows = (q.data ?? []).filter((r) =>
    filter === "all" ? true : !["MATCHED", "MANUAL", "IGNORED"].includes(r.status),
  );

  const decide = async (matchId: string, biomieId: string | null, ignore: boolean) => {
    const note = window.prompt("Justificativa da decisão (fica registrada na auditoria):");
    if (!note || note.trim().length < 3) return;
    try {
      await resolve({ data: { matchId, biomieId, ignore, note } });
      toast.success("Decisão registrada.");
      qc.invalidateQueries({ queryKey: ["omie-comparison", company, entity] });
      qc.invalidateQueries({ queryKey: ["integrations", company] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comparação OMIE × BIOMIE</CardTitle>
        <CardDescription>
          Conflitos e registros sem correspondência exigem decisão humana.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Tabs value={entity} onValueChange={(v) => setEntity(v as Entity)}>
            <TabsList>
              {(Object.keys(ENTITY_LABEL) as Entity[]).map((e) => (
                <TabsTrigger key={e} value={e}>
                  {ENTITY_LABEL[e]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              <TabsTrigger value="pending">Pendentes</TabsTrigger>
              <TabsTrigger value="all">Todos</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2">Omie</th>
                <th>BIOMIE</th>
                <th>Método</th>
                <th>Divergência</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.isLoading && (
                <tr>
                  <td colSpan={6} className="py-4 text-muted-foreground">
                    Carregando…
                  </td>
                </tr>
              )}
              {!q.isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-muted-foreground">
                    Nada a mostrar. Sincronize a entidade para gerar a comparação.
                  </td>
                </tr>
              )}
              {rows.slice(0, 300).map((r) => (
                <tr key={r.match_id ?? r.canonical_id} className="border-b last:border-0">
                  <td className="py-2">
                    {r.omie_name}
                    <span className="block text-xs text-muted-foreground">
                      {r.omie_code || r.external_id}
                      {r.missing_in_source && " · ausente no Omie"}
                    </span>
                  </td>
                  <td>{r.biomie_name ?? "—"}</td>
                  <td className="text-xs">
                    {r.method ?? "—"}
                    {r.candidates > 1 && ` · ${r.candidates} candidatos`}
                  </td>
                  <td className="text-xs">{r.divergence || "—"}</td>
                  <td>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </td>
                  <td className="text-right">
                    {r.match_id && !["MATCHED", "MANUAL", "IGNORED"].includes(r.status) && (
                      <div className="flex justify-end gap-1">
                        {r.biomie_id && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => decide(r.match_id, r.biomie_id, false)}
                          >
                            Confirmar
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => decide(r.match_id, null, true)}
                        >
                          Ignorar
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 300 && (
            <p className="pt-2 text-xs text-muted-foreground">Mostrando 300 de {rows.length}.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
