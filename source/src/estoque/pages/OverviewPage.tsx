import { useCapabilities, useStockCompany } from "../lib/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { stockApi } from "../api";
import type { CurveRun, StockOverview } from "../api/contract";
import { PageTitle } from "../components/StockLayout";
import { CurveBadge, Metric, Notice, Readings, Status } from "../components/shared";
import { money, quantity, errorMessage, dateTime } from "../lib/format";
import { AGING_BANDS, WINDOW_LABELS, shortDate } from "../lib/curves";
import { ProjectionChart } from "../components/ProjectionChart";
import { chartProjection } from "../lib/simulation";

/** Situação do cálculo da curva de cada empresa que não está em dia. */
function curveProblem(c: CurveRun): string | null {
  if (c.status === "missing")
    return `${c.companyName}: curva ainda não calculada. Ela aparece depois da próxima leitura do estoque.`;
  if (c.status === "skipped")
    return `${c.companyName}: cálculo adiado (${c.reason ?? "notas em sincronização"}). Valem as curvas de ${dateTime(c.computedAt)}.`;
  if (c.status === "failed")
    return `${c.companyName}: o último cálculo falhou (${c.reason ?? "erro"}). Valem as curvas de ${dateTime(c.computedAt)}.`;
  return null;
}

function CurveInfo({ data }: { data: StockOverview }) {
  const label = WINDOW_LABELS[data.window ?? "12m"];
  const runs = (data.curves ?? []).filter((c) => c.computedAt);
  const incomplete = runs.filter((c) => c.incompleteHistory);
  const problems = (data.curves ?? []).map(curveProblem).filter((p): p is string => p !== null);
  const first = runs[0];
  return (
    <div className="space-y-3">
      {first && (
        <p className="text-sm text-muted-foreground">
          Curva automática de {label}: faturamento de {shortDate(first.windowStart)} a{" "}
          {shortDate(first.asOf)} · calculada em {dateTime(first.computedAt)} · A até 80%, B até
          95%, C demais com venda, D com saldo e sem venda.
        </p>
      )}
      {incomplete.length > 0 && (
        <Notice>
          Janela de {label} com histórico incompleto: as vendas no BIOMIE começam em{" "}
          {incomplete
            .map((c) => `${shortDate(c.salesFrom)} (${c.companyName})`)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(", ")}
          . Produtos sem venda nesse período aparecem como “histórico incompleto”, não como estoque
          parado confirmado.
        </Notice>
      )}
      {problems.map((p) => (
        <Notice key={p}>{p}</Notice>
      ))}
    </div>
  );
}

export function OverviewPage() {
  const { companyId, window } = useStockCompany();
  const caps = useCapabilities();
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["stock", "overview", companyId, window],
    queryFn: () => stockApi.overview(companyId, window),
    retry: false,
  });
  const data = q.data;
  const base = useQuery({
    queryKey: ["stock", "simulation", companyId, window],
    queryFn: () => stockApi.simulationBase(companyId, window),
    enabled: caps.data?.viewCost === true,
    retry: false,
  });
  const chart = base.data
    ? chartProjection(base.data.items, { cuts: { A: 0, B: 0, C: 0, D: 0 }, discount: 0 })
    : null;
  const d = data?.dAnalysis;
  const label = WINDOW_LABELS[data?.window ?? window];
  return (
    <>
      <PageTitle
        title="Visão geral do estoque"
        description="Posição física consolidada · última leitura completa"
      />
      <Status
        loading={q.isPending || caps.isPending}
        error={q.error || caps.error}
        empty={data?.totals.positions === 0}
        retry={() => {
          q.refetch();
          caps.refetch();
        }}
      />
      {data && caps.data && data.totals.positions > 0 && (
        <>
          {data.readings.some((r) => r.status === "stale") && (
            <Notice>Leitura com mais de 6 horas. Os números podem estar desatualizados.</Notice>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {caps.data.viewCost && (
              <Metric
                label="Estoque a custo"
                value={money(data.totals.costValue)}
                foot="Quantidade física × CMC"
              />
            )}
            <Metric
              label="Unidades físicas"
              value={quantity(data.totals.units)}
              foot={
                data.totals.positionsWithStock === undefined
                  ? `${data.totals.positions} posições · produto × local`
                  : `${data.totals.positionsWithStock} posições com saldo · ${data.totals.positions} no total`
              }
            />
            <Metric
              label="Reservado"
              value={quantity(data.totals.reservedQty)}
              foot="Não deduzido do físico"
            />
            <Metric
              label="Pendente em pedidos"
              value={quantity(data.totals.pendingQty)}
              foot="Não deduzido do físico"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              to="/estoque/posicoes"
              search={{ onlyNegative: true }}
              className="rounded-md border px-4 py-3 text-sm hover:bg-muted"
            >
              {data.totals.negativePositions} posições com saldo negativo →
            </Link>
            {(data.totals.belowMinPositions ?? 0) > 0 && (
              <Link
                to="/estoque/posicoes"
                search={{ belowMin: true }}
                className="rounded-md border px-4 py-3 text-sm hover:bg-muted"
              >
                {data.totals.belowMinPositions} abaixo do estoque mínimo do Omie →
              </Link>
            )}
            {(data.totals.manualCurves ?? 0) > 0 && (
              <Link
                to="/estoque/posicoes"
                search={{ onlyManual: true, view: "product" }}
                className="rounded-md border px-4 py-3 text-sm hover:bg-muted"
              >
                {data.totals.manualCurves} produtos com curva manual →
              </Link>
            )}
          </div>
          <section className="space-y-4">
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-lg font-semibold">Distribuição por curva · {label}</h2>
              {caps.data.viewCost && (
                <p className="text-sm text-muted-foreground">
                  Capital em C + D:{" "}
                  <span className="font-semibold text-foreground">
                    {money((data.byCurve[2]?.costValue ?? 0) + (data.byCurve[3]?.costValue ?? 0))}
                  </span>
                </p>
              )}
            </div>
            <CurveInfo data={data} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {data.byCurve.map((c) => (
                <Link
                  key={c.curve}
                  to="/estoque/posicoes"
                  search={{ curve: c.curve, view: "product" }}
                  className="space-y-3 rounded-lg border bg-card p-4 hover:border-primary"
                >
                  <CurveBadge curve={c.curve} />
                  {caps.data.viewCost && (
                    <p className="break-words text-lg font-semibold">{money(c.costValue)}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {quantity(c.units)} unidades ·{" "}
                    {c.products === undefined
                      ? `${c.positions} posições`
                      : `${c.products} produtos`}
                  </p>
                  {caps.data.viewCost && (
                    <p className="text-xs text-muted-foreground">
                      {c.share === null
                        ? "Participação indisponível"
                        : `${c.share.toFixed(1).replace(".", ",")}% do valor`}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </section>
          {d && d.products > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">
                Curva D aberta · {d.products} produtos com saldo sem venda em {label}
                {caps.data.viewCost ? ` · ${money(d.costValue)}` : ""}
              </h2>
              <p className="text-sm text-muted-foreground">
                Antes de tratar como capital parado: produto novo não é encalhe, e histórico
                incompleto não confirma falta de venda.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {[
                  {
                    key: "confirmed",
                    title: "Sem venda confirmada",
                    products: d.confirmedProducts,
                    value: d.confirmedCostValue,
                    foot: "Histórico cobre a janela inteira",
                    search: { curve: "D" as const, onlyConfirmed: true, view: "product" as const },
                  },
                  {
                    key: "incomplete",
                    title: "Histórico incompleto",
                    products: d.incompleteProducts,
                    value: d.incompleteCostValue,
                    foot: "Sem venda no histórico disponível",
                    search: { curve: "D" as const, onlyIncomplete: true, view: "product" as const },
                  },
                  {
                    key: "new",
                    title: "Produtos novos",
                    products: d.newProducts,
                    value: d.newCostValue,
                    foot: "Chegaram há pouco: sem alerta",
                    search: { curve: "D" as const, onlyNew: true, view: "product" as const },
                  },
                  {
                    key: "moving",
                    title: "Com saída nos últimos 90 dias",
                    products: d.movingProducts ?? 0,
                    value: d.movingCostValue ?? null,
                    foot: "Teve saída do estoque: conferir antes de tratar como parado",
                    search: { curve: "D" as const, recentExit: true, view: "product" as const },
                  },
                  {
                    key: "elsewhere",
                    title: "Vendidos por outra empresa",
                    products: d.elsewhereProducts,
                    value: d.elsewhereCostValue,
                    foot: "Mesma SKU com venda no grupo em 12 meses",
                    search: { curve: "D" as const, soldElsewhere: true, view: "product" as const },
                  },
                ].map((c) => (
                  <Link
                    key={c.key}
                    to="/estoque/posicoes"
                    search={c.search}
                    className="space-y-2 rounded-lg border bg-card p-4 hover:border-primary"
                  >
                    <p className="text-sm font-medium">{c.title}</p>
                    {caps.data?.viewCost && (
                      <p className="text-lg font-semibold">{money(c.value)}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {c.products} produtos · {c.foot}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {(data.aging ?? []).some((a) => a.products > 0) && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Tempo sem venda · produtos com saldo</h2>
              <p className="text-sm text-muted-foreground">
                Independente da janela da curva. Conta da última venda até hoje.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {AGING_BANDS.map((b) => {
                  const a = data.aging?.find((x) => x.band === b.band);
                  return (
                    <Link
                      key={b.band}
                      to="/estoque/posicoes"
                      search={{ minDaysWithoutSale: b.days, view: "product" }}
                      className="space-y-2 rounded-lg border bg-card p-4 hover:border-primary"
                    >
                      <p className="text-sm font-medium">{b.label}</p>
                      <p className="text-xs text-muted-foreground">{b.range}</p>
                      {caps.data?.viewCost && (
                        <p className="text-lg font-semibold">{money(a?.costValue ?? 0)}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {a?.products ?? 0} produtos
                        {(a?.newProducts ?? 0) > 0 ? ` · ${a?.newProducts} novos` : ""}
                        {(a?.incompleteProducts ?? 0) > 0
                          ? ` · ${a?.incompleteProducts} com histórico incompleto`
                          : ""}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}
          {caps.data.viewCost && (
            <section className="grid gap-6 border-y py-6 lg:grid-cols-2">
              <div className="min-w-0">
                <h2 className="mb-3 text-lg font-semibold">Valor por empresa</h2>
                <div className="divide-y">
                  {data.byCompany.map((c) => (
                    <div
                      key={c.companyId}
                      className="flex flex-wrap justify-between gap-2 py-3 text-sm"
                    >
                      <span>{c.companyName}</span>
                      <strong>{money(c.costValue)}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="min-w-0">
                <h2 className="mb-3 text-lg font-semibold">Estoque a custo por curva</h2>
                {chart && (
                  <ProjectionChart data={chart.data.map((c) => ({ ...c, projected: 0 }))} />
                )}
                <p className="text-xs text-muted-foreground">
                  {chart?.excludedCount ?? 0} posições negativas ({money(chart?.excludedValue ?? 0)}
                  ) fora das barras, preservadas nos totais.
                </p>
              </div>
            </section>
          )}
          <Readings
            readings={data.readings}
            refresh={
              caps.data.refresh
                ? async (id) => {
                    try {
                      const r = await stockApi.requestRefresh(id);
                      if (r.queued)
                        toast.success(
                          "Leitura solicitada. Os números mudam quando a leitura completa terminar.",
                        );
                      else if (r.inProgress)
                        toast.info("Já existe uma leitura em andamento para esta empresa.");
                      else
                        toast.info(
                          `Nova solicitação liberada em ${dateTime(r.nextAllowedAt)} (Brasília).`,
                        );
                      await client.invalidateQueries({ queryKey: ["stock", "overview"] });
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }
                : undefined
            }
          />
        </>
      )}
    </>
  );
}
