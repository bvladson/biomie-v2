/**
 * Gráficos da Inteligência do Estoque. Cada gráfico tem a tabela equivalente (botão Tabela), a dica
 * no passar do mouse e rótulos diretos só onde cabem; as cores vêm das escalas validadas em
 * styles.css (curvas em azul, tempo sem venda em laranja) e o rótulo sempre acompanha a cor.
 */
import { useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ChartColumn, Table2 } from "lucide-react";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ClassifiedCurve, Curve } from "../api/contract";
import type {
  CurveCapital,
  IntelBand,
  IntelOverview,
  IntelPareto,
  IntelState,
} from "../api/intel-contract";
import { money, quantity } from "../lib/format";
import { shortDate } from "../lib/curves";
import {
  BAND_COLORS,
  BAND_LABELS,
  BAND_SHORT,
  CURVE_COLORS,
  STATE_LABELS,
  STATE_ORDER,
  STATE_RULES,
  compactMoney,
  compactNumber,
  curveDistribution,
  evolutionRows,
  integer,
  monthLabel,
  niceTicks,
  paretoChart,
  percentText,
  radarRows,
  type CurveMode,
  type EvolutionRow,
} from "../lib/intel";
import { StateBadge, TipBox } from "./IntelBits";

type TipProps = {
  active?: boolean | undefined;
  payload?: { payload?: unknown }[] | undefined;
};
const first = <T,>(props: TipProps) =>
  props.active && props.payload?.[0]?.payload ? (props.payload[0].payload as T) : null;

type LabelProps = {
  x?: number | string | undefined;
  y?: number | string | undefined;
  width?: number | string | undefined;
  height?: number | string | undefined;
  value?: unknown;
};
const num = (v: number | string | undefined) => Number(v ?? 0);
const labelValue = (v: unknown) => (typeof v === "number" ? v : null);

/** Valor na ponta da barra horizontal, numa linha só (o rótulo padrão quebra em barra curta). */
const endLabel = (fmt: (v: number | null) => string) =>
  function EndLabel(p: LabelProps) {
    return (
      <text
        x={num(p.x) + num(p.width) + 6}
        y={num(p.y) + num(p.height) / 2}
        dy="0.35em"
        fontSize={12}
        className="fill-foreground"
      >
        {fmt(labelValue(p.value))}
      </text>
    );
  };

/** Cartão de gráfico com a alternância Gráfico/Tabela (a tabela é a versão acessível). */
export function ChartCard({
  title,
  description,
  controls,
  table,
  children,
  footer,
  className,
}: {
  title: string;
  description?: ReactNode;
  controls?: ReactNode;
  table?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <section className={`panel min-w-0 space-y-4 p-5 ${className ?? ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {controls}
          {table && (
            <ToggleGroup
              type="single"
              variant="outline"
              value={view}
              onValueChange={(v) => (v === "chart" || v === "table") && setView(v)}
              aria-label={`Mostrar ${title.toLowerCase()} como`}
            >
              <ToggleGroupItem value="chart" aria-label="Gráfico" className="min-h-9 px-2.5">
                <ChartColumn aria-hidden />
              </ToggleGroupItem>
              <ToggleGroupItem value="table" aria-label="Tabela" className="min-h-9 px-2.5">
                <Table2 aria-hidden />
              </ToggleGroupItem>
            </ToggleGroup>
          )}
        </div>
      </div>
      {view === "table" && table ? <div className="overflow-x-auto">{table}</div> : children}
      {footer && <div className="text-xs text-muted-foreground">{footer}</div>}
    </section>
  );
}

/** Troca a medida do gráfico (não é filtro: os mesmos dados, outra unidade). */
export function MeasureToggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  if (options.length < 2) return null;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      onValueChange={(v) => {
        const hit = options.find((o) => o.value === v);
        if (hit) onChange(hit.value);
      }}
      aria-label={label}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="min-h-9 px-2.5 text-xs">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const sumUnknown = (byCurve: Record<Curve, CurveCapital>) =>
  (["A", "B", "C", "D", "U"] as Curve[]).reduce((n, c) => n + (byCurve[c]?.unknownCost ?? 0), 0);

// ------------------------------------------------------------------ distribuição ABCD

export function CurveChart({
  overview,
  viewCost,
  windowLabel,
  onSelect,
}: {
  overview: IntelOverview;
  viewCost: boolean;
  windowLabel: string;
  onSelect: (curve: ClassifiedCurve) => void;
}) {
  const [mode, setMode] = useState<CurveMode>(viewCost ? "capital" : "products");
  const byCurve = overview.capital.byCurve;
  const rows = curveDistribution(byCurve, mode);
  const fmt = (v: number | null) =>
    v === null
      ? "—"
      : mode === "capital"
        ? compactMoney(v)
        : mode === "share"
          ? percentText(v)
          : integer(v);
  const unknown = sumUnknown(byCurve);
  const negative = overview.capital.negative;
  const u = byCurve.U?.products ?? 0;
  return (
    <ChartCard
      title={`${viewCost ? "Capital" : "Produtos"} por curva · ${windowLabel}`}
      description={
        viewCost
          ? "Saldos positivos a custo. Clique numa curva para abrir as posições."
          : "Produtos com saldo positivo. Clique numa curva para abrir as posições."
      }
      controls={
        <MeasureToggle
          label="Medida da distribuição por curva"
          value={mode}
          onChange={setMode}
          options={
            viewCost
              ? [
                  { value: "capital", label: "Capital" },
                  { value: "products", label: "Produtos" },
                  { value: "share", label: "%" },
                ]
              : [{ value: "products", label: "Produtos" }]
          }
        />
      }
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Curva</TableHead>
              <TableHead className="text-right">Produtos com saldo</TableHead>
              {viewCost && <TableHead className="text-right">Capital</TableHead>}
              {viewCost && <TableHead className="text-right">% do capital</TableHead>}
              <TableHead className="text-right">Sem custo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {curveDistribution(byCurve, "share").map((r) => (
              <TableRow key={r.curve}>
                <TableCell>Curva {r.curve}</TableCell>
                <TableCell className="text-right tabular-nums">{integer(r.products)}</TableCell>
                {viewCost && (
                  <TableCell className="text-right tabular-nums">{money(r.capital)}</TableCell>
                )}
                {viewCost && (
                  <TableCell className="text-right tabular-nums">{percentText(r.value)}</TableCell>
                )}
                <TableCell className="text-right tabular-nums">
                  {integer(byCurve[r.curve]?.unknownCost ?? 0)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      footer={
        <>
          {viewCost &&
            unknown > 0 &&
            `${integer(unknown)} produto(s) com saldo e sem custo no Omie ficam fora do capital. `}
          {negative.positions > 0 &&
            `Saldos negativos ficam à parte: ${integer(negative.positions)} posição(ões)${
              viewCost && negative.value !== null ? ` (${money(negative.value)})` : ""
            }. `}
          {u > 0 && `${integer(u)} produto(s) com saldo ainda sem curva.`}
        </>
      }
    >
      <ChartContainer config={{ value: { label: "Valor" } }} className="aspect-auto h-52 w-full">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 76, bottom: 4, left: 0 }}
          barCategoryGap={10}
          accessibilityLayer
        >
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            type="category"
            dataKey="curve"
            tickFormatter={(c: string) => `Curva ${c}`}
            width={64}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            content={(props: TipProps) => {
              const r = first<(typeof rows)[number]>(props);
              if (!r) return null;
              return (
                <TipBox
                  title={`Curva ${r.curve}`}
                  rows={[
                    ...(viewCost
                      ? [{ key: "c", label: "capital", value: money(r.capital), color: r.fill }]
                      : []),
                    { key: "p", label: "produtos com saldo", value: integer(r.products) },
                  ]}
                />
              );
            }}
          />
          <Bar
            dataKey="value"
            radius={[0, 4, 4, 0]}
            maxBarSize={24}
            isAnimationActive={false}
            className="cursor-pointer"
            onClick={(entry: { curve?: Curve }) => {
              if (entry.curve && entry.curve !== "U") onSelect(entry.curve);
            }}
          >
            {rows.map((r) => (
              <Cell key={r.curve} fill={r.fill} />
            ))}
            <LabelList dataKey="value" content={endLabel(fmt)} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

// ------------------------------------------------------------------ radar do capital parado

export function IdleRadar({
  overview,
  viewCost,
  onSelect,
}: {
  overview: IntelOverview;
  viewCost: boolean;
  onSelect: (band: IntelBand) => void;
}) {
  const [mode, setMode] = useState<"capital" | "products">(viewCost ? "capital" : "products");
  const rows = radarRows(overview.radar, mode).map((r) => ({
    ...r,
    short: BAND_SHORT[r.band],
    fill: BAND_COLORS[r.band],
  }));
  const fmt = (v: number | null) =>
    v === null ? "—" : mode === "capital" ? compactMoney(v) : integer(v);
  const news = rows.find((r) => r.band === "insuficiente")?.newProducts ?? 0;
  return (
    <ChartCard
      title="Radar do capital parado"
      description="Produtos com saldo pelo tempo desde a última venda. Clique numa faixa para listar os produtos."
      controls={
        <MeasureToggle
          label="Medida do radar"
          value={mode}
          onChange={setMode}
          options={
            viewCost
              ? [
                  { value: "capital", label: "Capital" },
                  { value: "products", label: "Produtos" },
                ]
              : [{ value: "products", label: "Produtos" }]
          }
        />
      }
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tempo sem venda</TableHead>
              <TableHead className="text-right">Produtos</TableHead>
              {viewCost && <TableHead className="text-right">Capital</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.band}>
                <TableCell>{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">{integer(r.products)}</TableCell>
                {viewCost && (
                  <TableCell className="text-right tabular-nums">{money(r.capital)}</TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      footer={
        <>
          Conta da última venda até a data da análise; quem nunca vendeu conta desde o início do
          histórico de vendas ou da chegada (o que for mais recente).
          {news > 0 &&
            ` ${integer(news)} produto(s) novo(s) estão em “Histórico insuficiente” e não contam como parados.`}
        </>
      }
    >
      <ChartContainer config={{ value: { label: "Valor" } }} className="aspect-auto h-72 w-full">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 76, bottom: 4, left: 0 }}
          barCategoryGap={6}
          accessibilityLayer
        >
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis type="category" dataKey="short" width={84} tickLine={false} axisLine={false} />
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            content={(props: TipProps) => {
              const r = first<(typeof rows)[number]>(props);
              if (!r) return null;
              return (
                <TipBox
                  title={r.label}
                  rows={[
                    ...(viewCost
                      ? [{ key: "c", label: "capital", value: money(r.capital), color: r.fill }]
                      : []),
                    { key: "p", label: "produtos com saldo", value: integer(r.products) },
                  ]}
                  note={
                    r.newProducts > 0 ? `${integer(r.newProducts)} produto(s) novo(s)` : undefined
                  }
                />
              );
            }}
          />
          <Bar
            dataKey="value"
            radius={[0, 4, 4, 0]}
            maxBarSize={24}
            isAnimationActive={false}
            className="cursor-pointer"
            onClick={(entry: { band?: IntelBand }) => entry.band && onSelect(entry.band)}
          >
            {rows.map((r) => (
              <Cell key={r.band} fill={r.fill} />
            ))}
            <LabelList dataKey="value" content={endLabel(fmt)} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

// ------------------------------------------------------------------ estados

export function StatesList({
  overview,
  viewCost,
  active,
  onSelect,
}: {
  overview: IntelOverview;
  viewCost: boolean;
  active?: IntelState | undefined;
  onSelect: (state: IntelState) => void;
}) {
  const byState = new Map(overview.states.map((s) => [s.state, s]));
  const total = overview.states.reduce((n, s) => n + s.products, 0);
  const rows = STATE_ORDER.map((state) => {
    const x = byState.get(state);
    return { state, products: x?.products ?? 0, capital: x?.capital ?? null };
  });
  return (
    <section className="panel min-w-0 space-y-4 p-5">
      <div>
        <h2 className="text-base font-semibold">Diagnóstico por estado</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {integer(total)} produtos analisados. Cada produto tem um único estado; clique para
          listar.
        </p>
      </div>
      <ul className="divide-y">
        {rows.map((r) => {
          const share = total ? r.products / total : 0;
          return (
            <li key={r.state}>
              <button
                type="button"
                onClick={() => onSelect(r.state)}
                aria-pressed={active === r.state}
                disabled={r.products === 0}
                title={STATE_RULES[r.state]}
                className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-2.5 text-left hover:bg-muted disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent ${
                  active === r.state ? "bg-accent" : ""
                }`}
              >
                <StateBadge state={r.state} />
                <span className="text-right text-sm tabular-nums">
                  {integer(r.products)}
                  {viewCost && r.capital !== null && (
                    <span className="ml-2 text-muted-foreground">{compactMoney(r.capital)}</span>
                  )}
                </span>
                <span aria-hidden className="col-span-2 h-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-muted-foreground/60"
                    style={{ width: `${share * 100}%` }}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Como cada estado é definido
        </summary>
        <dl className="mt-3 space-y-2">
          {STATE_ORDER.map((s) => (
            <div key={s}>
              <dt className="font-medium">{STATE_LABELS[s]}</dt>
              <dd className="text-muted-foreground">{STATE_RULES[s]}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

// ------------------------------------------------------------------ evolução

const CURVES: ClassifiedCurve[] = ["A", "B", "C", "D"];

function CurveLegend() {
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      aria-label="Legenda"
    >
      {CURVES.map((c) => (
        <li key={c} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-[2px]"
            style={{ background: CURVE_COLORS[c] }}
          />
          Curva {c}
        </li>
      ))}
    </ul>
  );
}

export function EvolutionChart({
  overview,
  viewCost,
}: {
  overview: IntelOverview;
  viewCost: boolean;
}) {
  const [mode, setMode] = useState<"capital" | "products">(viewCost ? "capital" : "products");
  const evolution = overview.evolution;
  const rows = evolutionRows(evolution, mode);
  const yTicks = niceTicks(Math.max(0, ...rows.map((r) => r.total ?? 0)));
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : mode === "capital" ? money(v) : integer(v);
  const firstDay = evolution[0]?.day;
  const description = firstDay
    ? `Uma foto por dia desde ${shortDate(firstDay)}, na leitura publicada${
        mode === "capital" ? " (capital em R$)" : " (produtos com saldo)"
      }. O passado não é reconstruído a partir da posição de hoje.`
    : "A primeira foto diária aparece depois da próxima análise.";
  return (
    <ChartCard
      title="Evolução por curva"
      description={description}
      controls={
        <MeasureToggle
          label="Medida da evolução"
          value={mode}
          onChange={setMode}
          options={
            viewCost
              ? [
                  { value: "capital", label: "Capital" },
                  { value: "products", label: "Produtos" },
                ]
              : [{ value: "products", label: "Produtos" }]
          }
        />
      }
      table={
        evolution.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dia</TableHead>
                {CURVES.map((c) => (
                  <TableHead key={c} className="text-right">
                    Curva {c}
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.day}>
                  <TableCell>{shortDate(r.day)}</TableCell>
                  {CURVES.map((c) => (
                    <TableCell key={c} className="text-right tabular-nums">
                      {fmt(r[c])}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums">{fmt(r.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : undefined
      }
    >
      {evolution.length < 2 ? (
        <div className="flex min-h-40 flex-col justify-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {evolution.length === 0 ? (
            <p>Ainda não há fotos diárias.</p>
          ) : (
            <>
              <p>
                Primeira foto em {shortDate(evolution[0]!.day)}:{" "}
                {CURVES.map((c) => `${c} ${fmt(rows[0]?.[c])}`).join(" · ")}.
              </p>
              <p>O gráfico aparece a partir da segunda foto.</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <CurveLegend />
          <ChartContainer config={{ A: { label: "Curva A" } }} className="aspect-auto h-64 w-full">
            <BarChart
              data={rows}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              accessibilityLayer
            >
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                minTickGap={12}
              />
              <YAxis
                width={52}
                domain={[0, yTicks[yTicks.length - 1] ?? 0]}
                ticks={yTicks}
                tickLine={false}
                axisLine={false}
                tickFormatter={compactNumber}
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)" }}
                content={(props: TipProps) => {
                  const r = first<EvolutionRow>(props);
                  if (!r) return null;
                  return (
                    <TipBox
                      title={shortDate(r.day)}
                      rows={[
                        ...[...CURVES].reverse().map((c) => ({
                          key: c,
                          label: `Curva ${c}`,
                          value: fmt(r[c]),
                          color: CURVE_COLORS[c],
                        })),
                        { key: "t", label: "total", value: fmt(r.total) },
                      ]}
                    />
                  );
                }}
              />
              {CURVES.map((c, i) => (
                <Bar
                  key={c}
                  dataKey={c}
                  stackId="curvas"
                  fill={CURVE_COLORS[c]}
                  stroke="var(--card)"
                  strokeWidth={2}
                  maxBarSize={24}
                  radius={i === CURVES.length - 1 ? [4, 4, 0, 0] : 0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </ChartCard>
  );
}

// ------------------------------------------------------------------ Pareto

export function ParetoView({ pareto, windowLabel }: { pareto: IntelPareto; windowLabel: string }) {
  const chart = paretoChart(pareto, 60);
  const line = pareto.rows.map((r) => ({
    rank: r[0],
    sku: r[2],
    name: r[3],
    revenue: r[4],
    share: r[5],
    cum: Math.round(r[6] * 10000) / 100,
    curve: r[7],
    manual: r[8],
  }));
  const zones = (["A", "B", "C"] as const)
    .map((c) => {
      const ranks = line.filter((p) => p.curve === c).map((p) => p.rank);
      return ranks.length ? { curve: c, from: Math.min(...ranks), to: Math.max(...ranks) } : null;
    })
    .filter((z): z is { curve: "A" | "B" | "C"; from: number; to: number } => z !== null);
  const n = line.length;
  const [limitA, limitB] = pareto.limits;
  // Marcas redondas no eixo da posição (1, 50, 100…), sem casas decimais.
  const step = n <= 50 ? 10 : n <= 200 ? 25 : n <= 500 ? 50 : n <= 1000 ? 100 : 250;
  const xTicks = [1, ...Array.from({ length: Math.floor(n / step) }, (_, i) => (i + 1) * step)];
  if (n === 0)
    return (
      <ChartCard title={`Pareto do faturamento · ${windowLabel}`}>
        <p className="text-sm text-muted-foreground">Nenhuma venda nesta janela.</p>
      </ChartCard>
    );
  return (
    <ChartCard
      title={`Pareto do faturamento · ${windowLabel}`}
      description={`Faturamento acumulado do produto que mais vende ao que menos vende (${integer(n)} produtos com venda, ${money(pareto.total)}). As faixas mostram as curvas automáticas.`}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">#</TableHead>
              <TableHead>Produto</TableHead>
              <TableHead className="text-right">Faturamento</TableHead>
              <TableHead className="text-right">Participação</TableHead>
              <TableHead className="text-right">Acumulado</TableHead>
              <TableHead>Curva</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {chart.bars.map((b) => (
              <TableRow key={b.omieProductId}>
                <TableCell className="text-right tabular-nums">{b.rank}</TableCell>
                <TableCell className="min-w-56 whitespace-normal">
                  <p>{b.name}</p>
                  <p className="text-xs text-muted-foreground">{b.sku}</p>
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(b.revenue)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {percentText(line[b.rank - 1]?.share ?? null, 2)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {b.cumulativePct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                </TableCell>
                <TableCell>
                  {b.curve}
                  {b.manual && b.manual !== b.curve ? ` (manual ${b.manual})` : ""}
                </TableCell>
              </TableRow>
            ))}
            {chart.rest.products > 0 && (
              <TableRow>
                <TableCell />
                <TableCell colSpan={5} className="text-muted-foreground">
                  Mais {integer(chart.rest.products)} produtos ({money(chart.rest.revenue)}).
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      }
      footer={
        <>
          Curva A: {integer(chart.counts.A)} produtos até {limitA}% do faturamento · B:{" "}
          {integer(chart.counts.B)} até {limitB}% · C: {integer(chart.counts.C)} no restante. Quem
          atravessa o limite fica na faixa que estava sendo preenchida. Curvas manuais não mudam o
          Pareto.
        </>
      }
    >
      <ul
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label="Legenda"
      >
        {zones.map((z) => (
          <li key={z.curve} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-[2px] opacity-40"
              style={{ background: CURVE_COLORS[z.curve] }}
            />
            Faixa da curva {z.curve} ({integer(z.to - z.from + 1)})
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-3 rounded bg-foreground" />
          Faturamento acumulado
        </li>
      </ul>
      <ChartContainer config={{ cum: { label: "Acumulado" } }} className="aspect-auto h-72 w-full">
        <LineChart
          data={line}
          margin={{ top: 12, right: 16, bottom: 0, left: 0 }}
          accessibilityLayer
        >
          {zones.map((z) => (
            <ReferenceArea
              key={z.curve}
              x1={z.from - 0.5}
              x2={z.to + 0.5}
              fill={CURVE_COLORS[z.curve]}
              fillOpacity={0.14}
              strokeOpacity={0}
              ifOverflow="hidden"
            />
          ))}
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="rank"
            domain={[0.5, n + 0.5]}
            ticks={xTicks}
            allowDecimals={false}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            tickFormatter={(v: number) => `${integer(v)}º`}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            width={44}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />
          <ReferenceLine
            y={limitA}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.6}
            label={{
              value: `${limitA}%`,
              position: "insideBottomLeft",
              fontSize: 11,
              fill: "var(--muted-foreground)",
            }}
          />
          <ReferenceLine
            y={limitB}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.6}
            label={{
              value: `${limitB}%`,
              position: "insideBottomLeft",
              fontSize: 11,
              fill: "var(--muted-foreground)",
            }}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
            content={(props: TipProps) => {
              const p = first<(typeof line)[number]>(props);
              if (!p) return null;
              return (
                <TipBox
                  title={`${p.rank}º · ${p.name}`}
                  rows={[
                    { key: "r", label: "faturamento", value: money(p.revenue) },
                    { key: "s", label: "do total", value: percentText(p.share, 2) },
                    {
                      key: "c",
                      label: "acumulado",
                      value: `${p.cum.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`,
                      color: "var(--foreground)",
                    },
                  ]}
                  note={`${p.sku ?? ""} · curva ${p.curve}${p.manual && p.manual !== p.curve ? ` (manual ${p.manual})` : ""}`}
                />
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="cum"
            stroke="var(--foreground)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

// ------------------------------------------------------------------ vendas por mês (produto)

export function MonthlySalesChart({
  months,
}: {
  months: [string, number | null, (number | null)?][];
}) {
  const rows = months.map(([month, units]) => ({ month, label: monthLabel(month), units }));
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">Sem histórico de vendas no BIOMIE.</p>;
  const sold = rows.filter((r) => (r.units ?? 0) > 0);
  const peak = sold.length
    ? sold.reduce((a, b) => ((b.units ?? 0) > (a.units ?? 0) ? b : a))
    : null;
  return (
    <div className="space-y-2">
      <ChartContainer config={{ units: { label: "Unidades" } }} className="aspect-auto h-44 w-full">
        <BarChart data={rows} margin={{ top: 16, right: 4, bottom: 0, left: 0 }} accessibilityLayer>
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
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            content={(props: TipProps) => {
              const r = first<(typeof rows)[number]>(props);
              if (!r) return null;
              return (
                <TipBox
                  title={r.label}
                  rows={[
                    {
                      key: "u",
                      label: "unidades vendidas",
                      value: r.units === null ? "sem histórico" : quantity(r.units),
                      color: "var(--chart-1)",
                    },
                  ]}
                />
              );
            }}
          />
          <Bar
            dataKey="units"
            fill="var(--chart-1)"
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="units"
              content={(p: LabelProps) => {
                const v = labelValue(p.value);
                if (!peak || !v || v !== peak.units) return null;
                return (
                  <text
                    x={num(p.x) + num(p.width) / 2}
                    y={num(p.y) - 6}
                    textAnchor="middle"
                    fontSize={11}
                    className="fill-muted-foreground"
                  >
                    {quantity(v)}
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">
        Unidades vendidas por mês ({rows[0]!.label} a {rows[rows.length - 1]!.label}); o primeiro e
        o último mês podem estar incompletos. Meses sem barra não tiveram venda.
      </p>
    </div>
  );
}
