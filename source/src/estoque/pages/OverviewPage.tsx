import { useCapabilities, useStockCompany } from "../lib/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { stockApi } from "../api";
import { PageTitle } from "../components/StockLayout";
import { CurveBadge, Metric, Notice, Readings, Status } from "../components/shared";
import { money, quantity, errorMessage, dateTime } from "../lib/format";
import { ProjectionChart } from "../components/ProjectionChart";
import { chartProjection } from "../lib/simulation";
export function OverviewPage() {
  const { companyId } = useStockCompany();
  const caps = useCapabilities();
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["stock", "overview", companyId],
    queryFn: () => stockApi.overview(companyId),
    retry: false,
  });
  const data = q.data;
  const base = useQuery({
    queryKey: ["stock", "simulation", companyId],
    queryFn: () => stockApi.simulationBase(companyId),
    enabled: caps.data?.viewCost === true,
    retry: false,
  });
  const chart = base.data
    ? chartProjection(base.data.items, { cuts: { A: 0, B: 0, C: 0, D: 0 }, discount: 0 })
    : null;
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
            <Link
              to="/estoque/posicoes"
              search={{ curve: "U" }}
              className="rounded-md border px-4 py-3 text-sm hover:bg-muted"
            >
              {data.totals.unclassifiedPositions} posições sem curva →
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
          </div>
          <section className="space-y-4">
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-lg font-semibold">Distribuição por curva</h2>
              {caps.data.viewCost && (
                <p className="text-sm text-muted-foreground">
                  Capital em C + D:{" "}
                  <span className="font-semibold text-foreground">
                    {money((data.byCurve[2]?.costValue ?? 0) + (data.byCurve[3]?.costValue ?? 0))}
                  </span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {data.byCurve.map((c) => (
                <Link
                  key={c.curve}
                  to="/estoque/posicoes"
                  search={{ curve: c.curve }}
                  className="space-y-3 rounded-lg border bg-card p-4 hover:border-primary"
                >
                  <CurveBadge curve={c.curve} />
                  {caps.data.viewCost && (
                    <p className="break-words text-lg font-semibold">{money(c.costValue)}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {quantity(c.units)} unidades · {c.positions} posições
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
