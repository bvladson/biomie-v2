/**
 * Inteligência do produto, fases 3 a 5: diagnósticos, recomendações, alertas (com ciência), previsão
 * de demanda, reposição, movimentações por semana e oportunidades entre empresas. Tudo é leitura do que
 * o motor publicou; "Estou ciente" só registra a ciência (com auditoria), nada muda no Omie.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import {
  BellRing,
  CircleAlert,
  CircleCheck,
  Info,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type {
  IntelAlert,
  IntelDiagnosis,
  IntelEvidence,
  IntelForecast,
  IntelProductDetail,
  IntelRecommendation,
  IntelReplenishment,
  IntelSeverity,
} from "../api/intel-contract";
import { intelApi } from "../api/intel";
import { dateTime, errorMessage, money, quantity } from "../lib/format";
import { shortDate } from "../lib/curves";
import { STATE_LABELS, compactNumber } from "../lib/intel";
import {
  DEMAND_CLASS_LABELS,
  FORECAST_STATUS_LABELS,
  MODEL_LABELS,
  QUALITY_LABELS,
  QUALITY_RULE,
  REPLENISHMENT_LABELS,
  SEVERITY_LABELS,
  SEVERITY_TONE,
  alertLabel,
  evidenceValue,
  forecastRange,
  forecastRows,
  movementWeeks,
  recLabel,
} from "../lib/intel-insights";
import { TipBox } from "./IntelBits";

const SEVERITY_ICON: Record<IntelSeverity, LucideIcon> = {
  alta: OctagonAlert,
  media: TriangleAlert,
  baixa: CircleAlert,
  info: Info,
};
const TONE_ICON = {
  critical: "text-destructive",
  serious: "text-risk",
  warning: "text-warning",
  neutral: "text-muted-foreground",
} as const;

/** Gravidade com ícone e rótulo (a cor nunca é a única informação). */
export function SeverityBadge({ severity }: { severity: IntelSeverity }) {
  const Icon = SEVERITY_ICON[severity];
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium">
      <Icon aria-hidden className={`size-3.5 shrink-0 ${TONE_ICON[SEVERITY_TONE[severity]]}`} />
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

export function EvidenceList({ items }: { items: IntelEvidence[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((e) => (
        <div key={e.key} className="flex gap-1">
          <dt className="text-muted-foreground">{e.label}:</dt>
          <dd className="tabular-nums">{evidenceValue(e)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ children }: { children: ReactNode }) {
  return <div className="rounded-md border bg-card px-3.5 py-3">{children}</div>;
}

export function DiagnosisList({ items }: { items: IntelDiagnosis[] | undefined }) {
  if (!items || items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nenhuma regra de diagnóstico se aplicou com os dados desta análise.
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.map((d, i) => (
        <li key={`${d.code}-${i}`}>
          <Block>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{d.title}</p>
              <SeverityBadge severity={d.severity} />
            </div>
            <p className="mt-1 text-sm">{d.text}</p>
            <EvidenceList items={d.evidence} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Regra {d.rule}
              {d.period ? ` · ${d.period}` : ""}
            </p>
          </Block>
        </li>
      ))}
    </ul>
  );
}

export function RecommendationList({ items }: { items: IntelRecommendation[] | undefined }) {
  if (!items || items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Sem recomendação: nenhuma regra pediu ação para este produto. Ausência de recomendação é
        preferível a uma recomendação sem base.
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.map((r, i) => (
        <li key={`${r.type}-${i}`}>
          <Block>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{r.action}</p>
              <Badge variant="outline" className="font-normal">
                {recLabel(r.type)}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{r.why}</p>
            <EvidenceList items={r.evidence} />
            {r.limitations.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {r.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Regra {r.rule} · consultiva: o BIOMIE não compra, não transfere e não muda preço.
            </p>
          </Block>
        </li>
      ))}
    </ul>
  );
}

function AckDialog({
  alert,
  onClose,
  onDone,
}: {
  alert: IntelAlert | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={alert !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar ciência do alerta</DialogTitle>
          <DialogDescription>
            {alert ? `${alertLabel(alert.kind)}: ${alert.reason}` : ""} O alerta continua aberto até
            a regra deixar de encontrar o problema; se a gravidade aumentar, ele volta a pedir
            atenção.
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-2 text-sm">
          Observação (opcional)
          <Textarea
            aria-label="Observação da ciência"
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy || !alert}
            onClick={async () => {
              if (!alert) return;
              setBusy(true);
              try {
                await intelApi.ackAlert(alert.id, note.trim() || null);
                toast.success("Ciência registrada.");
                setNote("");
                onDone();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Estou ciente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lista de alertas guardados (do produto ou da empresa), com novo/mudou, ciência e resolvidos. */
export function AlertRows({
  alerts,
  canAck,
  showProduct,
  onChanged,
  onOpenProduct,
}: {
  alerts: IntelAlert[];
  canAck: boolean;
  showProduct?: boolean;
  onChanged: () => void;
  onOpenProduct?: (a: IntelAlert) => void;
}) {
  const [ack, setAck] = useState<IntelAlert | null>(null);
  if (alerts.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nenhum alerta aberto ou resolvido recentemente.
      </p>
    );
  return (
    <>
      <ul className="space-y-2">
        {alerts.map((a) => (
          <li key={a.id}>
            <Block>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{alertLabel(a.kind)}</span>
                  {a.isNew && (
                    <Badge className="font-normal">
                      <BellRing aria-hidden className="size-3" /> Novo
                    </Badge>
                  )}
                  {a.changed && (
                    <Badge variant="secondary" className="font-normal">
                      Gravidade mudou
                    </Badge>
                  )}
                  {a.status === "resolved" && (
                    <Badge variant="outline" className="font-normal">
                      <CircleCheck aria-hidden className="size-3" /> Resolvido
                    </Badge>
                  )}
                </div>
                <SeverityBadge severity={a.severity} />
              </div>
              {showProduct && (
                <p className="mt-1 text-sm">
                  {onOpenProduct ? (
                    <button
                      type="button"
                      className="text-left underline-offset-2 hover:underline"
                      onClick={() => onOpenProduct(a)}
                    >
                      {[a.sku, a.name].filter(Boolean).join(" · ") || a.omieProductId}
                    </button>
                  ) : (
                    [a.sku, a.name].filter(Boolean).join(" · ")
                  )}
                  {a.companyName ? (
                    <span className="text-muted-foreground"> · {a.companyName}</span>
                  ) : null}
                </p>
              )}
              <p className="mt-1 text-sm">{a.reason}</p>
              <EvidenceList items={a.evidence} />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Regra {a.rule} · desde {dateTime(a.firstSeenAt)}
                {a.status === "resolved" && a.resolvedAt
                  ? ` · resolvido em ${dateTime(a.resolvedAt)}`
                  : ""}
              </p>
              {a.acknowledged ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Ciência de {a.acknowledged.by} em {dateTime(a.acknowledged.at)}
                  {a.acknowledged.note ? `: “${a.acknowledged.note}”` : ""}
                </p>
              ) : (
                canAck &&
                a.status === "open" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 min-h-9"
                    onClick={() => setAck(a)}
                  >
                    Estou ciente
                  </Button>
                )
              )}
            </Block>
          </li>
        ))}
      </ul>
      <AckDialog
        alert={ack}
        onClose={() => setAck(null)}
        onDone={() => {
          setAck(null);
          onChanged();
        }}
      />
    </>
  );
}

type TipProps = { active?: boolean | undefined; payload?: { payload?: unknown }[] | undefined };
const dec = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
const first = <T,>(p: TipProps) =>
  p.active && p.payload?.[0]?.payload ? (p.payload[0].payload as T) : null;

/** Previsão: semanas vendidas, o que o modelo previa uma semana antes e as próximas 13 semanas. */
export function ForecastPanel({ f }: { f: IntelForecast | undefined }) {
  if (!f)
    return (
      <p className="text-sm text-muted-foreground">
        Esta análise é anterior à previsão de demanda (motor anterior à versão 1.1).
      </p>
    );
  const rows = forecastRows(f);
  const ok = f.status === "ok" && f.horizons && f.backtest;
  const today = rows.find((r) => r.weekEnd === f.series.weekEnd)?.label;
  return (
    <div className="space-y-3">
      {!ok && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm">
          {f.message ?? FORECAST_STATUS_LABELS[f.status]}
        </p>
      )}
      {rows.some((r) => (r.actual ?? 0) > 0 || r.forecast !== null) && (
        <ChartContainer
          config={{ actual: { label: "Vendido" }, fitted: { label: "Previsto antes" } }}
          className="aspect-auto h-52 w-full"
        >
          <ComposedChart
            data={rows}
            margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              interval="preserveStartEnd"
            />
            <YAxis
              width={36}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              tickFormatter={compactNumber}
            />
            {ok && today !== undefined && (
              <ReferenceLine x={today} stroke="var(--muted-foreground)" strokeDasharray="2 3" />
            )}
            <ChartTooltip
              cursor={{ fill: "var(--muted)" }}
              content={(props: TipProps) => {
                const r = first<(typeof rows)[number]>(props);
                if (!r) return null;
                return (
                  <TipBox
                    title={`Semana até ${shortDate(r.weekEnd)}`}
                    rows={[
                      ...(r.actual !== null
                        ? [
                            {
                              key: "a",
                              label: "vendidas",
                              value: quantity(r.actual),
                              color: "var(--chart-1)",
                            },
                          ]
                        : []),
                      ...(r.fitted !== null
                        ? [
                            {
                              key: "f",
                              label: "previstas uma semana antes",
                              value: quantity(Math.round(r.fitted * 100) / 100),
                              color: "var(--chart-4)",
                            },
                          ]
                        : []),
                      ...(r.forecast !== null && r.actual === null
                        ? [
                            {
                              key: "p",
                              label: "previstas (taxa semanal)",
                              value: quantity(Math.round(r.forecast * 100) / 100),
                              color: "var(--chart-2)",
                            },
                          ]
                        : []),
                    ]}
                  />
                );
              }}
            />
            <Bar
              dataKey="actual"
              fill="var(--chart-1)"
              radius={[3, 3, 0, 0]}
              maxBarSize={14}
              isAnimationActive={false}
            />
            <Line
              dataKey="fitted"
              stroke="var(--chart-4)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              dataKey="forecast"
              stroke="var(--chart-2)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartContainer>
      )}
      <p className="text-xs text-muted-foreground">
        Barras: unidades vendidas por semana. Linha contínua: o que o modelo escolhido previa uma
        semana antes, só com o passado. Tracejado: a previsão para as próximas semanas.
      </p>
      {ok && f.horizons && f.backtest && (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Horizonte</TableHead>
                  <TableHead className="text-right">Previsão</TableHead>
                  <TableHead className="text-right">Erro no teste</TableHead>
                  <TableHead className="text-right">Cortes do teste</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(["30", "60", "90"] as const).map((h) => {
                  const x = f.horizons![h];
                  return (
                    <TableRow key={h}>
                      <TableCell>{h} dias</TableCell>
                      <TableCell className="text-right tabular-nums">{forecastRange(x)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {x.wape === null
                          ? "não avaliável"
                          : `${Math.round(x.wape * 100)}% do vendido`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{x.origins}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {(
              [
                ["Modelo escolhido", f.model ? MODEL_LABELS[f.model] : "—"],
                ["Qualidade no teste", QUALITY_LABELS[f.backtest.quality]],
                [
                  "Ganho sobre a média de 13 semanas",
                  f.backtest.skillVsBase === null
                    ? "—"
                    : `${Math.round(f.backtest.skillVsBase * 100)}%`,
                ],
                [
                  "Viés",
                  f.backtest.bias === null
                    ? "—"
                    : `${f.backtest.bias > 0 ? "+" : ""}${Math.round(f.backtest.bias * 100)}% (+ = previsão acima do real)`,
                ],
                [
                  "Demanda",
                  f.demandClass
                    ? `${DEMAND_CLASS_LABELS[f.demandClass]} (ADI ${dec(f.adi)}, CV² ${dec(f.cv2)})`
                    : "—",
                ],
                [
                  "Treino",
                  f.trainFrom
                    ? `${shortDate(f.trainFrom)} a ${shortDate(f.trainTo)} · ${f.weeks} semanas, ${f.nonzeroWeeks} com venda`
                    : "—",
                ],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-dashed pb-1">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {QUALITY_RULE}{" "}
            {f.intervalBasis
              ? `${f.intervalBasis}; não é um intervalo de confiança calibrado.`
              : "Sem faixa: menos de 10 cortes no teste histórico."}{" "}
            Sazonalidade: não avaliável com menos de 2 anos de histórico.
          </p>
        </>
      )}
      {f.limitations.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {f.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Reposição do produto: situação, contas e o porquê; custo estimado só para quem vê custo. */
export function ReplenishmentBlock({
  r,
  viewCost,
}: {
  r: IntelReplenishment | Record<string, never> | undefined;
  viewCost: boolean;
}) {
  if (!r || !("status" in r))
    return (
      <p className="text-sm text-muted-foreground">
        Esta análise é anterior à Reposição Inteligente.
      </p>
    );
  if (
    r.status === "sem_fornecedor" ||
    r.status === "fornecedor_indefinido" ||
    r.status === "sem_prazo" ||
    r.status === "sem_previsao" ||
    r.status === "sem_demanda"
  )
    return (
      <div className="space-y-2">
        <p className="rounded-md border border-dashed px-3 py-2 text-sm">
          {REPLENISHMENT_LABELS[r.status]}. {r.message}
        </p>
        {(r.notes ?? []).map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}
      </div>
    );
  const test = r.leadTimeStatus === "teste";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={r.status === "comprar" ? "default" : "outline"} className="font-normal">
          {REPLENISHMENT_LABELS[r.status]}
        </Badge>
        {r.status === "comprar" && (
          <span className="text-sm font-medium">
            {quantity(r.qty ?? 0)} un. sugeridas
            {viewCost && r.costEstimate !== undefined
              ? ` · ${r.costEstimate === null ? "custo estimado indisponível" : `≈ ${money(r.costEstimate)} a custo`}`
              : ""}
          </span>
        )}
      </div>
      {test && (
        <p className="rounded-md border border-amber-500/50 px-3 py-2 text-sm" role="note">
          Prazo configurado na simulação: {r.leadTimeDays} dias. O prazo deve ser confirmado por
          Compras antes de servir de base a recomendações reais.
        </p>
      )}
      {r.risk && <p className="text-sm">{r.risk}</p>}
      {r.explanation && (
        <p className="text-sm text-muted-foreground">{r.explanation.replace(/\.$/, "")}.</p>
      )}
      <EvidenceList items={r.evidence ?? []} />
      <p className="text-xs text-muted-foreground">
        {r.supplier
          ? `Fornecedor ${r.supplier.name}${
              r.supplier.choice === "principal"
                ? " (principal, definido por Compras)"
                : r.supplier.choice === "unico_com_prazo"
                  ? " (o único vinculado com prazo)"
                  : ""
            }: p`
          : "P"}
        razo de {r.leadTimeDays} dias corridos{" "}
        {r.leadTimeSource === "produto" ? "deste produto" : "padrão do fornecedor"}
        {test ? " (simulação)" : ""}; revisão a cada {r.reviewDays} dias; nível de serviço{" "}
        {Math.round((r.serviceLevel ?? 0) * 100)}%
        {r.serviceLevelCurve && r.serviceLevelCurve !== "U"
          ? ` (curva ${r.serviceLevelCurve}`
          : " (sem curva"}
        {r.policySource === "padrao" ? ", padrão do BIOMIE)" : ", política de Compras)"}.
        {r.reorderFromOmieMin
          ? " O ponto de reposição usa o mínimo cadastrado no Omie (maior que o calculado)."
          : ""}
      </p>
      {(r.limitations ?? []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {r
            .limitations!.filter((l) => !(test && l.startsWith("Prazo configurado na simulação")))
            .map((l) => (
              <li key={l}>{l}</li>
            ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Sugestão para revisão humana: o BIOMIE não cria pedido de compra no Omie.
      </p>
    </div>
  );
}

/** Compras e vendas por semana e o saldo estimado no fim de cada semana (quando os dados fecham). */
export function MovementsChart({ d }: { d: IntelProductDetail }) {
  if (!d.movements)
    return (
      <p className="text-sm text-muted-foreground">Movimentações indisponíveis nesta versão.</p>
    );
  const { rows, stockConsistent } = movementWeeks(d.movements, d.run.asOf, d.metrics.stock.qty);
  const any = rows.some((r) => r.purchases || r.sales || r.other);
  if (!any)
    return (
      <p className="text-sm text-muted-foreground">Nenhuma movimentação nas últimas 26 semanas.</p>
    );
  return (
    <div className="space-y-2">
      <ChartContainer
        config={{
          purchases: { label: "Compras" },
          sales: { label: "Vendas" },
          stock: { label: "Saldo" },
        }}
        className="aspect-auto h-52 w-full"
      >
        <ComposedChart
          data={rows}
          margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="q"
            width={36}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickFormatter={compactNumber}
          />
          {stockConsistent && (
            <YAxis
              yAxisId="s"
              orientation="right"
              width={40}
              tickLine={false}
              axisLine={false}
              tickFormatter={compactNumber}
            />
          )}
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            content={(props: TipProps) => {
              const r = first<(typeof rows)[number]>(props);
              if (!r) return null;
              return (
                <TipBox
                  title={`Semana até ${shortDate(r.weekEnd)}`}
                  rows={[
                    {
                      key: "p",
                      label: "compras/produção",
                      value: quantity(r.purchases),
                      color: "var(--chart-1)",
                    },
                    {
                      key: "v",
                      label: "vendas",
                      value: quantity(r.sales),
                      color: "var(--age-3)",
                    },
                    {
                      key: "o",
                      label: "outras (ajustes, transferências, estornos)",
                      value: quantity(r.other),
                    },
                    ...(r.stock !== null
                      ? [
                          {
                            key: "s",
                            label: "saldo estimado no fim da semana",
                            value: quantity(r.stock),
                            color: "var(--foreground)",
                          },
                        ]
                      : []),
                  ]}
                />
              );
            }}
          />
          <Bar
            yAxisId="q"
            dataKey="purchases"
            fill="var(--chart-1)"
            radius={[3, 3, 0, 0]}
            maxBarSize={10}
            isAnimationActive={false}
          />
          <Bar
            yAxisId="q"
            dataKey="sales"
            fill="var(--age-3)"
            radius={[3, 3, 0, 0]}
            maxBarSize={10}
            isAnimationActive={false}
          />
          {stockConsistent && (
            <Line
              yAxisId="s"
              dataKey="stock"
              stroke="var(--foreground)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">
        Barras azuis: compras/produção; laranja: vendas (movimentações do Omie, por semana).{" "}
        {stockConsistent
          ? "Linha: saldo estimado no fim de cada semana (saldo atual − entradas + saídas posteriores)."
          : "Saldo semanal não mostrado: as movimentações não cobrem as 26 semanas ou não fecham com o saldo atual."}
      </p>
    </div>
  );
}

/** Oportunidades entre empresas que envolvem o produto (só com acesso às duas empresas). */
export function ProductOpportunities({
  d,
  viewCost,
}: {
  d: IntelProductDetail;
  viewCost: boolean;
}) {
  const q = useQuery({
    queryKey: ["stock", "intel", "opportunities", "product", d.companyId, d.omieProductId],
    queryFn: () =>
      intelApi.opportunities({ companyId: d.companyId, omieProductId: d.omieProductId, page: 0 }),
    retry: false,
  });
  if (q.isPending) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (q.error) return <p className="text-sm">{errorMessage(q.error)}</p>;
  if (!q.data || q.data.rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nenhuma oportunidade com outra empresa nesta análise (mesma SKU com sobra numa e falta
        noutra).
      </p>
    );
  return (
    <div className="space-y-2">
      {q.data.rows.map((o) => (
        <Block key={`${o.fromCompanyId}-${o.fromOmie}-${o.toCompanyId}-${o.toOmie}`}>
          <p className="text-sm font-medium">
            {o.fromCompanyName} → {o.toCompanyName}: até {quantity(o.qty)} un.
            {viewCost && o.valueAtCost !== undefined && o.valueAtCost !== null
              ? ` (≈ ${money(o.valueAtCost)} a custo)`
              : ""}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{o.reason}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Origem: {STATE_LABELS[o.from.state]} · destino com cobertura de{" "}
            {quantity(o.to.coverageDays)} dias.
          </p>
        </Block>
      ))}
      <p className="text-xs text-muted-foreground">{q.data.note}</p>
    </div>
  );
}
