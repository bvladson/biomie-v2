import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Alert, AlertState, AlertType, Initiative } from "../api/contract";
import { flightPlanApi } from "../api";
import { brl0, dateBr, dateTimeBr, dayMonth } from "../lib/format";
import {
  canCreateAlertAction,
  canDecide as canDecideWeekly,
  canManageAlert,
} from "../lib/permissions";
import { fpKey, useFilters, useMe, usePlan, useSellers } from "../lib/hooks";
import { addDays, mondayOf } from "../lib/dates";
import { whatsappSummary } from "../lib/summary";
import { ErrorState, Loading, Panel, StatusBadge, statusText } from "../components/bits";
import { InitiativeDialog, type InitiativeDraft } from "../components/InitiativeDialog";
import { HistoryPanel } from "../components/HistoryPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const TYPE_PT: Record<AlertType, string> = {
  BELOW_FLIGHT_LINE: "Abaixo da linha de voo",
  LOW_COVERAGE: "Cobertura baixa",
  PACE_ACCELERATION: "Aceleração necessária",
  GAP_UNREACHABLE: "Meta inalcançável",
  LATE_ORDERS: "Pedidos atrasados",
  STALE_QUOTES: "Orçamentos parados",
  SELLER_IDLE: "Vendedor parado",
  STATUS_WORSENED: "Status piorou",
  NO_TARGET: "Mês sem meta",
  NO_CALENDAR: "Calendário sem feriados",
};
const STATE_PT: Record<AlertState, string> = {
  OPEN: "Aberto",
  ACKNOWLEDGED: "Ciente",
  ACTION_CREATED: "Ação criada",
  RESOLVED: "Resolvido",
};
const PRIO_PT = { 1: "Prioridade alta", 2: "Prioridade média", 3: "Prioridade baixa" } as const;
const LEVER_BY_TYPE: Partial<Record<AlertType, Initiative["lever"]>> = {
  STALE_QUOTES: "CONVERT_QUOTES",
  LATE_ORDERS: "OTHER",
  SELLER_IDLE: "PROSPECTING",
  LOW_COVERAGE: "CONVERT_QUOTES",
};

export function CorrectionPage() {
  return (
    <div className="space-y-5">
      <Tabs defaultValue="alertas">
        <TabsList>
          <TabsTrigger value="alertas">Alertas</TabsTrigger>
          <TabsTrigger value="reuniao">Reunião semanal</TabsTrigger>
          <TabsTrigger value="evolucao">Evolução</TabsTrigger>
        </TabsList>
        <TabsContent value="alertas">
          <Alerts />
        </TabsContent>
        <TabsContent value="reuniao">
          <Weekly />
        </TabsContent>
        <TabsContent value="evolucao">
          <Evolution />
        </TabsContent>
      </Tabs>
      <HistoryPanel area="correcao" />
    </div>
  );
}

function Alerts() {
  const f = useFilters();
  const me = useMe();
  const sellers = useSellers();
  const client = useQueryClient();
  const q = useQuery({
    queryKey: fpKey(f.persona, "alerts", f.query),
    queryFn: () => flightPlanApi.listAlerts(f.query),
  });
  const [seller, setSeller] = useState("all"),
    [type, setType] = useState("all"),
    [state, setState] = useState("active");
  const [ack, setAck] = useState<Alert | null>(null);
  const [action, setAction] = useState<{ alert: Alert; draft: InitiativeDraft } | null>(null);
  const setStateM = useMutation({
    mutationFn: (v: {
      key: string;
      state: AlertState;
      note: string | null;
      initiativeId?: string;
    }) => flightPlanApi.setAlertState(v.key, v.state, v.note, v.initiativeId, f.query),
    onSuccess: () => {
      toast.success("Alerta atualizado");
      client.invalidateQueries({ queryKey: fpKey(f.persona) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });
  if (q.isPending || me.isPending) return <Loading label="Calculando alertas…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (me.isError) return <ErrorState error={me.error} retry={() => me.refetch()} />;
  const name = (id: string | null) =>
    id ? (sellers.data?.find((s) => s.id === id)?.name ?? id) : f.company.name;
  const canManage = (a: Alert) => canManageAlert(me.data, a.sellerId);
  const canAct = (a: Alert) => canCreateAlertAction(me.data, a.sellerId);
  const list = q.data.filter(
    (a) =>
      (seller === "all" || (a.sellerId ?? "empresa") === seller) &&
      (type === "all" || a.type === type) &&
      (state === "all" || (state === "active" ? a.state !== "RESOLVED" : a.state === state)),
  );
  const types = [...new Set(q.data.map((a) => a.type))];
  const sellerOpts = [...new Set(q.data.map((a) => a.sellerId ?? "empresa"))];
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-3">
        <Filter
          id="al-seller"
          label="Vendedor"
          value={seller}
          onChange={setSeller}
          options={[
            ["all", "Todos"],
            ...sellerOpts.map(
              (s) => [s, s === "empresa" ? "Empresa" : name(s)] as [string, string],
            ),
          ]}
        />
        <Filter
          id="al-type"
          label="Tipo"
          value={type}
          onChange={setType}
          options={[["all", "Todos"], ...types.map((t) => [t, TYPE_PT[t]] as [string, string])]}
        />
        <Filter
          id="al-state"
          label="Estado"
          value={state}
          onChange={setState}
          options={[["active", "Não resolvidos"], ["all", "Todos"], ...Object.entries(STATE_PT)]}
        />
      </div>
      {list.length === 0 ? (
        <p className="rounded border border-dashed bg-card p-5 text-sm text-muted-foreground">
          Nenhum alerta neste filtro. O plano está sem desvios detectados.
        </p>
      ) : (
        ([1, 2, 3] as const).map((p) => {
          const items = list.filter((a) => a.priority === p);
          if (!items.length) return null;
          return (
            <Panel key={p} title={`${PRIO_PT[p]} (${items.length})`}>
              <ul className="space-y-3">
                {items.map((a) => (
                  <li key={a.key} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-secondary px-2 py-0.5 text-xs font-semibold">
                        {TYPE_PT[a.type]}
                      </span>
                      <span className="text-xs text-muted-foreground">{name(a.sellerId)}</span>
                      <span className="rounded border px-2 py-0.5 text-xs">
                        {STATE_PT[a.state]}
                      </span>
                      {a.reopened && (
                        <span className="rounded border border-destructive/40 px-2 py-0.5 text-xs font-semibold text-destructive">
                          Voltou
                        </span>
                      )}
                    </div>
                    <p className="mt-2 font-medium">{a.message}</p>
                    <p className="fp-num mt-1 text-sm text-muted-foreground">
                      Evidência: {a.evidence}
                    </p>
                    {a.note && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Nota: {a.note}
                        {a.updatedAt ? ` · ${dateTimeBr(a.updatedAt)}` : ""}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {canAct(a) && a.state !== "ACTION_CREATED" && a.state !== "RESOLVED" && (
                        <Button
                          size="sm"
                          onClick={() =>
                            setAction({
                              alert: a,
                              draft: {
                                title: `${TYPE_PT[a.type]}: ${name(a.sellerId)}`,
                                lever: LEVER_BY_TYPE[a.type] ?? "OTHER",
                                alertKey: a.key,
                                sellerIds: a.sellerId ? [a.sellerId] : [],
                                notes: a.evidence,
                                ...(me.data.sellerId
                                  ? { ownerUserId: `user:${me.data.userId}` }
                                  : {}),
                              },
                            })
                          }
                        >
                          Criar ação corretiva
                        </Button>
                      )}
                      {canManage(a) && a.state === "OPEN" && (
                        <Button size="sm" variant="outline" onClick={() => setAck(a)}>
                          Ciente
                        </Button>
                      )}
                      {canManage(a) && a.state !== "RESOLVED" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setStateM.mutate({ key: a.key, state: "RESOLVED", note: null })
                          }
                        >
                          Resolvido
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          );
        })
      )}
      <AckDialog
        alert={ack}
        close={() => setAck(null)}
        onConfirm={(note) => {
          if (ack) setStateM.mutate({ key: ack.key, state: "ACKNOWLEDGED", note });
          setAck(null);
        }}
      />
      <InitiativeDialog
        open={!!action}
        onOpenChange={(o) => !o && setAction(null)}
        draft={action?.draft ?? null}
        me={me.data}
        sellers={sellers.data ?? []}
        onSaved={(i) => {
          if (action)
            setStateM.mutate({
              key: action.alert.key,
              state: "ACTION_CREATED",
              note: null,
              initiativeId: i.id,
            });
        }}
      />
    </div>
  );
}

function AckDialog({
  alert,
  close,
  onConfirm,
}: {
  alert: Alert | null;
  close: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={!!alert} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) {
              onConfirm(note.trim());
              setNote("");
            }
          }}
          className="space-y-3"
        >
          <DialogHeader>
            <DialogTitle>Marcar como ciente</DialogTitle>
            <DialogDescription>{alert?.message}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="ack-note">Justificativa *</Label>
            <Textarea id="ack-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Voltar
            </Button>
            <Button type="submit" disabled={!note.trim()}>
              Confirmar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Weekly() {
  const f = useFilters();
  const me = useMe();
  const plan = usePlan();
  const sellers = useSellers();
  const client = useQueryClient();
  const today = f.company.asOf;
  const weeks = Array.from({ length: 5 }, (_, i) => addDays(mondayOf(today), -7 * i));
  const [week, setWeek] = useState(weeks[0]!);
  const [text, setText] = useState("");
  const q = useQuery({
    queryKey: fpKey(f.persona, "weekly", f.query, week),
    queryFn: () => flightPlanApi.getWeeklyReview(f.query, week),
  });
  const inits = useQuery({
    queryKey: fpKey(f.persona, "initiatives", f.query),
    queryFn: () => flightPlanApi.listInitiatives(f.query),
  });
  const add = useMutation({
    mutationFn: () => flightPlanApi.addDecision(f.query, week, text),
    onSuccess: () => {
      setText("");
      toast.success("Decisão registrada");
      client.invalidateQueries({ queryKey: fpKey(f.persona) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });
  const name = (id: string) => sellers.data?.find((s) => s.id === id)?.name ?? id;
  const canDecide = !!me.data && canDecideWeekly(me.data);
  function copy() {
    if (!plan.data || !inits.data) return;
    const s = whatsappSummary({
      company: f.company.name,
      weekStart: week,
      realized: plan.data.summary.realized,
      attainment: plan.data.summary.attainment,
      forecast: plan.data.summary.forecastProbable,
      atRisk: plan.data.sellers.filter(
        (r) => r.metrics.status === "RISK" || r.metrics.status === "CRITICAL",
      ).length,
      openActions: inits.data.coverage.open,
      lateActions: inits.data.coverage.late,
    });
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip?.writeText) {
      toast.message("Copie o resumo abaixo", { description: s });
      return;
    }
    clip.writeText(s).then(
      () => toast.success("Resumo copiado", { description: s }),
      () => toast.message("Não foi possível copiar; copie o resumo abaixo", { description: s }),
    );
  }
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Filter
          id="wk"
          label="Semana (segunda a domingo)"
          value={week}
          onChange={setWeek}
          options={weeks.map(
            (w) => [w, `${dateBr(w)} a ${dateBr(addDays(w, 6))}`] as [string, string],
          )}
        />
        <Button variant="outline" onClick={copy} disabled={!plan.data || !inits.data}>
          <Copy className="size-4" aria-hidden />
          Copiar resumo
        </Button>
      </div>
      {q.isPending ? (
        <Loading label="Montando a reunião…" />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="O que mudou desde a segunda">
            <p className="text-sm">
              Realizado:{" "}
              <span className="fp-num font-semibold">
                {q.data.realizedChange >= 0 ? "+" : ""}
                {brl0(q.data.realizedChange)}
              </span>
            </p>
            <p className="text-sm">
              Previsão provável:{" "}
              <span className="fp-num font-semibold">
                {q.data.forecastChange === null
                  ? "—"
                  : (q.data.forecastChange >= 0 ? "+" : "") + brl0(q.data.forecastChange)}
              </span>
            </p>
            <h3 className="mt-3 text-sm font-semibold">Mudanças de status</h3>
            {q.data.statusChanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma.</p>
            ) : (
              <ul className="text-sm">
                {q.data.statusChanges.map((c) => (
                  <li key={c.sellerId}>
                    {name(c.sellerId)}: {statusText(c.from)} → {statusText(c.to)}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Alertas e iniciativas">
            <p className="text-sm">
              Alertas novos: <strong>{q.data.newAlerts.length}</strong>
            </p>
            <ul className="mb-2 list-disc pl-5 text-xs text-muted-foreground">
              {q.data.newAlerts.slice(0, 6).map((a) => (
                <li key={a.key}>{a.message}</li>
              ))}
            </ul>
            <p className="text-sm">
              Atrasadas: <strong>{q.data.lateInitiatives.length}</strong>{" "}
              {q.data.lateInitiatives.map((i) => i.title).join("; ")}
            </p>
            <p className="text-sm">
              Concluídas: <strong>{q.data.doneInitiatives.length}</strong>{" "}
              {q.data.doneInitiatives
                .map((i) => `${i.title} (${brl0(i.realizedAmount)})`)
                .join("; ")}
            </p>
          </Panel>
          <Panel title="Decisões da reunião" className="md:col-span-2">
            {q.data.decisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma decisão registrada.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {q.data.decisions.map((d) => (
                  <li key={d.id} className="rounded border p-2">
                    {d.text}
                    <span className="block text-xs text-muted-foreground">
                      {d.authorName} · {dateTimeBr(d.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canDecide && (
              <form
                className="mt-3 grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim()) add.mutate();
                }}
              >
                <Label htmlFor="dec-text">Nova decisão</Label>
                <Textarea
                  id="dec-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={2}
                />
                <Button
                  type="submit"
                  className="justify-self-start"
                  disabled={!text.trim() || add.isPending}
                >
                  Registrar decisão
                </Button>
              </form>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function Evolution() {
  const f = useFilters();
  const sellers = useSellers();
  const [subject, setSubject] = useState(f.search.vendedor ?? "company");
  const q = { ...f.query, ...(subject === "company" ? {} : { sellerId: subject }) };
  if (subject === "company") delete (q as { sellerId?: string }).sellerId;
  const snaps = useQuery({
    queryKey: fpKey(f.persona, "snapshots", q),
    queryFn: () => flightPlanApi.getSnapshots(q),
  });
  // Dias sem foto entram como pontos nulos para o gráfico mostrar lacuna.
  const series = (() => {
    if (!snaps.data?.length) return [];
    const byDate = new Map(snaps.data.map((s) => [s.date, s]));
    const out = [];
    for (let d = snaps.data[0]!.date; d <= snaps.data.at(-1)!.date; d = addDays(d, 1)) {
      const s = byDate.get(d);
      out.push({
        date: d,
        realized: s?.realized ?? null,
        forecast: s?.forecastProbable ?? null,
        target: s?.target ?? null,
        status: s?.status ?? null,
        missing: !s,
      });
    }
    return out;
  })();
  return (
    <div className="mt-4 space-y-4">
      <Filter
        id="ev-subject"
        label="Ver"
        value={subject}
        onChange={setSubject}
        options={[
          ["company", "Empresa / escopo"],
          ...(sellers.data ?? []).map((s) => [s.id, s.name] as [string, string]),
        ]}
      />
      {(f.query.channel || f.extraFilters) && (
        <p role="note" className="rounded-md border p-2 text-sm text-muted-foreground">
          As fotos diárias são da empresa inteira e de cada vendedor: tire o filtro de canal,
          filial, UF, cidade ou categoria para ver a evolução.
        </p>
      )}
      {snaps.isPending ? (
        <Loading label="Carregando fotos diárias…" />
      ) : snaps.isError ? (
        <ErrorState error={snaps.error} retry={() => snaps.refetch()} />
      ) : (
        <Panel title="Evolução pelas fotos diárias (desde 19/10/2026)">
          <div className="h-72 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <ComposedChart data={series}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={dayMonth}
                  tick={{ fontSize: 11 }}
                  minTickGap={18}
                />
                <YAxis
                  tickFormatter={(v: number) => v.toLocaleString("pt-BR", { notation: "compact" })}
                  tick={{ fontSize: 11 }}
                  width={44}
                />
                <Tooltip
                  formatter={(v: number) => brl0(v)}
                  labelFormatter={(l: string) => dateBr(l)}
                />
                <Line
                  dataKey="target"
                  name="Meta"
                  stroke="var(--chart-2)"
                  strokeDasharray="6 4"
                  dot={false}
                  connectNulls={false}
                />
                <Line
                  dataKey="realized"
                  name="Realizado acumulado"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
                <Line
                  dataKey="forecast"
                  name="Previsão provável"
                  stroke="var(--chart-4)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div
            className="mt-3 flex gap-0.5 overflow-x-auto pb-1"
            role="list"
            aria-label="Status por dia"
          >
            {series.map((s) => (
              <div
                key={s.date}
                role="listitem"
                className="flex min-w-9 flex-col items-center text-[10px]"
                title={`${dateBr(s.date)}: ${s.missing ? "sem foto" : statusText(s.status)}`}
              >
                {s.missing ? (
                  <span className="text-muted-foreground">—</span>
                ) : s.status ? (
                  <StatusBadge status={s.status} className="px-1 [&>span+*]:hidden" />
                ) : (
                  <span className="text-muted-foreground">·</span>
                )}
                <span className="text-muted-foreground">{dayMonth(s.date)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Dias sem foto aparecem como lacuna. Outubro não tinha meta, por isso sem status.
          </p>
        </Panel>
      )}
    </div>
  );
}

function Filter({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9 w-[220px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
