/** Inteligência de um produto: estado e evidências, prioridade explicada, vendas, curva e estoque. */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { IntelProductDetail, PriorityParts } from "../api/intel-contract";
import { intelApi } from "../api/intel";
import { dateTime, errorMessage, money, quantity } from "../lib/format";
import { exitLabel, operationLabel, shortDate } from "../lib/curves";
import { STATE_RULES, coverageText, days, evidence, integer, percentText } from "../lib/intel";
import { CurveBadge } from "./shared";
import { FlagList, PriorityMeter, StateBadge } from "./IntelBits";
import { MonthlySalesChart } from "./IntelCharts";

export interface IntelItem {
  companyId: string;
  omieProductId: string;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b border-dashed pb-1.5">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const FACTORS: { key: keyof Omit<PriorityParts, "weights">; label: string; help: string }[] = [
  {
    key: "capital",
    label: "Capital do produto",
    help: "Posição do capital do produto entre os da empresa (0 = menor, 1 = maior).",
  },
  { key: "idle", label: "Tempo sem venda", help: "Dias sem venda ÷ 365, até 1." },
  {
    key: "coverage",
    label: "Cobertura",
    help: "Dias que o saldo dura no ritmo atual ÷ 365, até 1; sem consumo conta 1.",
  },
  {
    key: "trend",
    label: "Queda da demanda",
    help: "Queda das vendas de 60 dias (50% = 0,5); alta conta 0.",
  },
];

function PriorityExplained({
  priority,
  parts,
}: {
  priority: number | null;
  parts: PriorityParts | null;
}) {
  if (priority === null || parts === null)
    return (
      <p className="text-sm text-muted-foreground">
        Sem prioridade: o produto não tem saldo positivo para liberar.
      </p>
    );
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fator</TableHead>
              <TableHead className="text-right">Nota (0–1)</TableHead>
              <TableHead className="text-right">Peso</TableHead>
              <TableHead className="text-right">Pontos</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {FACTORS.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="whitespace-normal">
                  <p>{f.label}</p>
                  <p className="text-xs text-muted-foreground">{f.help}</p>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {parts[f.key].toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {parts.weights[f.key].toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {(100 * parts[f.key] * parts.weights[f.key]).toLocaleString("pt-BR", {
                    maximumFractionDigits: 1,
                  })}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-medium">Prioridade</TableCell>
              <TableCell />
              <TableCell />
              <TableCell className="text-right font-medium tabular-nums">
                {priority.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Prioridade para liberar capital: soma de nota × peso × 100. Produto novo não pontua em tempo
        sem venda nem em cobertura.
      </p>
    </div>
  );
}

function Detail({ d, viewCost }: { d: IntelProductDetail; viewCost: boolean }) {
  const m = d.metrics;
  const windows = [
    ["30 dias", m.sales.d30],
    ["60 dias", m.sales.d60],
    ["90 dias", m.sales.d90],
    ["180 dias", m.sales.d180],
    ["12 meses", m.sales.d365],
  ] as const;
  return (
    <div className="space-y-5 pb-8">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <StateBadge state={d.state} className="text-base font-medium" />
        {m.curve.current && <CurveBadge curve={m.curve.current} />}
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          Prioridade <PriorityMeter value={d.priority} />
        </span>
      </div>
      <FlagList flags={d.flags} max={20} />

      <Section title="Por que este estado">
        <p className="text-sm">{STATE_RULES[d.state]}</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {evidence(d.state, m).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>

      <Section title="Como a prioridade foi calculada">
        <PriorityExplained priority={d.priority} parts={d.priorityParts} />
      </Section>

      <Section title="Vendas">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Período</TableHead>
                <TableHead className="text-right">Unidades</TableHead>
                <TableHead className="text-right">Notas</TableHead>
                {viewCost && <TableHead className="text-right">Faturamento</TableHead>}
                <TableHead className="text-right">Dias com histórico</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {windows.map(([label, w]) => (
                <TableRow key={label}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {w.units === null ? "sem histórico" : quantity(w.units)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {w.invoices === null ? "—" : integer(w.invoices)}
                  </TableCell>
                  {viewCost && (
                    <TableCell className="text-right tabular-nums">
                      {w.revenue === null || w.revenue === undefined ? "—" : money(w.revenue)}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {integer(w.coveredDays)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Facts
          rows={[
            [
              "Ritmo",
              m.velocityDaily === null
                ? "—"
                : `${m.velocityDaily.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} un./dia`,
            ],
            ["Cobertura do saldo", coverageText(m.coverageDays, m.velocityDaily)],
            [
              "Giro anual",
              m.turnoverAnnual === null
                ? "—"
                : m.turnoverAnnual.toLocaleString("pt-BR", { maximumFractionDigits: 2 }),
            ],
            [
              "Tendência (60 d × 60 d anteriores)",
              m.trend60Pct === null
                ? "—"
                : `${m.trend60Pct > 0 ? "+" : ""}${integer(Math.round(m.trend60Pct))}%`,
            ],
            ...(viewCost
              ? ([
                  [
                    "Preço médio vendido",
                    m.avgPrice === null || m.avgPrice === undefined ? "—" : money(m.avgPrice),
                  ],
                  [
                    "Margem estimada",
                    m.marginEstPct === null || m.marginEstPct === undefined
                      ? "—"
                      : `${m.marginEstPct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`,
                  ],
                ] as [string, ReactNode][])
              : []),
            [
              "Devoluções em 12 meses",
              m.returns365.units === null
                ? "—"
                : `${quantity(m.returns365.units)} un. em ${integer(m.returns365.events)} ${
                    m.returns365.events === 1 ? "devolução" : "devoluções"
                  }`,
            ],
            ["Vendido por outra empresa", m.elsewhereCompany ?? "—"],
          ]}
        />
        <MonthlySalesChart months={m.salesMonthly} />
      </Section>

      <Section title="Estoque">
        <Facts
          rows={[
            ["Saldo", m.stock.qty === null ? "—" : quantity(m.stock.qty)],
            ["Disponível", m.stock.available === null ? "—" : quantity(m.stock.available)],
            ["Reservado", m.stock.reserved === null ? "—" : quantity(m.stock.reserved)],
            ["Pendente em pedidos", m.stock.pending === null ? "—" : quantity(m.stock.pending)],
            ["Mínimo no Omie", m.stock.minQty ? quantity(m.stock.minQty) : "—"],
            ["Locais", m.stock.locations === null ? "—" : integer(m.stock.locations)],
            ["Locais com saldo negativo", integer(m.stock.negativePositions)],
            ...(viewCost
              ? ([
                  [
                    "CMC",
                    m.cost?.unitCost === null || m.cost?.unitCost === undefined
                      ? "desconhecido"
                      : money(m.cost.unitCost),
                  ],
                  [
                    "Capital (saldos positivos)",
                    m.capital === null || m.capital === undefined ? "—" : money(m.capital),
                  ],
                  ["Preço de venda no Omie", m.salePrice ? money(m.salePrice) : "não informado"],
                ] as [string, ReactNode][])
              : []),
          ]}
        />
      </Section>

      <Section title="Curva e movimentações">
        <Facts
          rows={[
            [
              "Curva de 12 meses",
              m.curve.current
                ? `${m.curve.current}${m.curve.source === "manual" ? " (manual)" : ""}`
                : "—",
            ],
            ["Participação no faturamento", percentText(m.curve.share12m, 2)],
            [
              "Curva anterior",
              m.curve.previous
                ? `${m.curve.previous}${
                    m.curve.changedOn && m.curve.current
                      ? ` · mudou para ${m.curve.current} em ${shortDate(m.curve.changedOn)}`
                      : ""
                  }`
                : "—",
            ],
            [
              "Última entrada",
              m.lastEntry
                ? `${shortDate(m.lastEntry)} · ${operationLabel(m.lastEntryOperation)}`
                : "—",
            ],
            [
              "Última saída",
              m.lastExit
                ? `${shortDate(m.lastExit)} · ${exitLabel(m.lastExitOperation, m.lastExitGroup)}`
                : "—",
            ],
            ["Chegada considerada", shortDate(m.arrivedOn)],
            ["Cadastro no Omie", shortDate(m.registeredAt)],
            ["Dias sem venda", days(m.daysWithoutSale)],
          ]}
        />
        {d.curveHistory.length > 0 && (
          <div className="text-sm">
            <p className="text-muted-foreground">Mudanças de curva registradas</p>
            <ul className="mt-1 space-y-0.5">
              {[...d.curveHistory].reverse().map((h) => (
                <li key={h.day} className="tabular-nums">
                  {shortDate(h.day)} · curva {h.curve}
                  {h.source === "manual" ? " (manual)" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <div className="flex flex-wrap gap-3 border-t pt-5">
        {d.productId && (
          <Link
            to="/produtos/$productId"
            params={{ productId: d.productId }}
            search={(prev) => ({ ...prev, company: d.companyId })}
            className="rounded-md border px-4 py-2.5 text-sm hover:bg-muted"
          >
            Abrir o produto →
          </Link>
        )}
        {d.productId && (
          <Link
            to="/estoque/posicoes"
            search={{ productId: d.productId, view: "position" }}
            className="rounded-md border px-4 py-2.5 text-sm hover:bg-muted"
          >
            Ver estoque por local →
          </Link>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Análise publicada em {dateTime(d.run.publishedAt)} (Brasília) com dados até{" "}
        {shortDate(d.run.asOf)} · motor {d.run.version}. Nada aqui altera o Omie.
      </p>
    </div>
  );
}

export function IntelProductSheet({
  item,
  onClose,
  viewCost,
}: {
  item: IntelItem | null;
  onClose: () => void;
  viewCost: boolean;
}) {
  const q = useQuery({
    queryKey: ["stock", "intel", "product", item?.companyId ?? null, item?.omieProductId ?? null],
    queryFn: () => intelApi.product(item!.companyId, item!.omieProductId),
    enabled: item !== null,
    retry: false,
  });
  const d = q.data;
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="mb-4">
          <SheetTitle className="pr-6">
            {d ? (d.name ?? d.sku ?? d.omieProductId) : "Inteligência do produto"}
          </SheetTitle>
          <SheetDescription>
            {d
              ? [d.sku, d.family, d.companyName].filter(Boolean).join(" · ")
              : "Indicadores da última análise publicada."}
          </SheetDescription>
        </SheetHeader>
        {q.isPending && item !== null ? (
          <div className="space-y-3" aria-busy="true" aria-label="Carregando produto">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-40" />
            <Skeleton className="h-56" />
          </div>
        ) : q.error ? (
          <p role="alert" className="text-sm">
            {errorMessage(q.error)}
          </p>
        ) : !d ? (
          <p className="text-sm text-muted-foreground">
            Este produto não está na última análise publicada.
          </p>
        ) : (
          <Detail d={d} viewCost={viewCost} />
        )}
      </SheetContent>
    </Sheet>
  );
}
