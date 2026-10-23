/**
 * Inteligência do Estoque (BIOMIE Intelligence, fase 2): cards, distribuição ABCD, radar do capital
 * parado, estados, evolução, Pareto e a lista de produtos com a explicação de cada um. Tudo é
 * leitura do que o motor já publicou; nada aqui altera o Omie nem os dados oficiais.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { appContextQuery } from "@/lib/queries";
import type { ClassifiedCurve } from "../api/contract";
import type { IntelBand, IntelOverview, IntelProductRow, IntelState } from "../api/intel-contract";
import { intelApi } from "../api/intel";
import { PageTitle } from "../components/StockLayout";
import { Notice, Status } from "../components/shared";
import { StatTile } from "../components/IntelBits";
import {
  CurveChart,
  EvolutionChart,
  IdleRadar,
  ParetoView,
  StatesList,
} from "../components/IntelCharts";
import { IntelTable } from "../components/IntelTable";
import { IntelProductSheet, type IntelItem } from "../components/IntelProductSheet";
import { useCapabilities, useStockCompany } from "../lib/hooks";
import { dateTime, money } from "../lib/format";
import { WINDOW_LABELS, shortDate } from "../lib/curves";
import { bandsAbove, compactMoney, integer, percentText } from "../lib/intel";
import { CLEAR, fromSearch, toSearch, type IntelFilters } from "../lib/intel-search";

const route = getRouteApi("/_authenticated/_shell/estoque/inteligencia");

function RunInfo({ o, isSuper }: { o: IntelOverview; isSuper: boolean }) {
  const runs = o.status.runs;
  const missing = o.companies.length - runs.length;
  const newest = runs.reduce<string | null>(
    (a, r) => (!a || r.publishedAt > a ? r.publishedAt : a),
    null,
  );
  const oldest = runs.reduce<(typeof runs)[number] | null>(
    (a, r) => (!a || r.publishedAt < a.publishedAt ? r : a),
    null,
  );
  const newerReading =
    newest !== null && o.status.readings.some((r) => r.readAt !== null && r.readAt > newest);
  return (
    <div className="space-y-3">
      {newest && (
        <p className="text-sm text-muted-foreground">
          Análise publicada em {dateTime(newest)} (Brasília) com vendas até{" "}
          {shortDate(runs[0]?.asOf)} · motor {runs[0]?.version}
          {o.status.salesFrom ? ` · vendas no BIOMIE desde ${shortDate(o.status.salesFrom)}` : ""}.
          Estados, radar e prioridades são dessa análise; capital por curva e evolução vêm da
          leitura de estoque publicada.
        </p>
      )}
      {!o.status.enabled && runs.length > 0 && (
        <Notice>
          O motor de inteligência está desligado: os números são da última análise publicada e não
          se atualizam sozinhos.
        </Notice>
      )}
      {oldest && newest && oldest.publishedAt !== newest && (
        <Notice>
          {oldest.companyName}: a análise em uso é de {dateTime(oldest.publishedAt)}; a execução
          mais recente não publicou resultado para esta empresa.
        </Notice>
      )}
      {missing > 0 && runs.length > 0 && (
        <Notice>{integer(missing)} empresa(s) ainda sem análise publicada.</Notice>
      )}
      {newerReading && (
        <p className="text-xs text-muted-foreground">
          Há leitura de estoque mais nova que a análise; os estados mudam na próxima análise.
        </p>
      )}
      {isSuper && runs.length === 0 && !o.status.enabled && (
        <p className="text-xs text-muted-foreground">
          Super admin: o motor está desligado. Ele roda em contêiner próprio e publica tudo de uma
          vez no fim; enquanto não houver análise, esta tela mostra só a distribuição por curva.
        </p>
      )}
    </div>
  );
}

export function IntelligencePage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const routeNavigate = route.useNavigate();
  const { companyId, window } = useStockCompany();
  const caps = useCapabilities();
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const isSuper = ctx.roles.includes("SUPER_ADMIN");
  const viewCost = caps.data?.viewCost === true;
  const canExport = caps.data?.export === true;
  const single = companyId !== "all";
  const [item, setItem] = useState<IntelItem | null>(null);

  const overview = useQuery({
    queryKey: ["stock", "intel", "overview", companyId, window],
    queryFn: () => intelApi.overview(companyId, window),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pareto = useQuery({
    queryKey: ["stock", "intel", "pareto", companyId, window],
    queryFn: () => intelApi.pareto(companyId, window),
    enabled: single && viewCost,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const filters = fromSearch(search);
  const update = useCallback(
    (patch: Partial<IntelFilters>, opts?: { replace?: boolean }) =>
      routeNavigate({
        search: (prev) => ({ ...prev, ...toSearch(patch) }),
        replace: opts?.replace ?? false,
        resetScroll: false,
      }),
    [routeNavigate],
  );
  /** Card, faixa ou estado: começa uma lista limpa com aquele filtro e desce até ela. */
  const drill = (patch: Partial<IntelFilters>) => {
    update({ ...CLEAR, ...patch });
    requestAnimationFrame(() =>
      document
        .getElementById("intel-produtos")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  // Outra empresa: volta para a primeira página e fecha o produto aberto.
  const lastCompany = useRef(companyId);
  useEffect(() => {
    if (lastCompany.current === companyId) return;
    lastCompany.current = companyId;
    setItem(null);
    if (search.pagina) update({ page: undefined }, { replace: true });
  }, [companyId, search.pagina, update]);

  const o = overview.data;
  const label = WINDOW_LABELS[o?.window ?? window];
  const hasRun = (o?.status.runs.length ?? 0) > 0;
  const stateOf = (s: IntelState) => o?.states.find((x) => x.state === s);
  const over180 = (o?.radar ?? []).filter((r) => bandsAbove(180).includes(r.band));
  const over180Products = over180.reduce((n, r) => n + r.products, 0);
  const over180Capital = viewCost ? over180.reduce((n, r) => n + (r.capital ?? 0), 0) : null;
  const tile = (s: IntelState) => {
    const x = stateOf(s);
    return {
      products: x?.products ?? 0,
      foot: viewCost && x?.capital ? compactMoney(x.capital) : undefined,
    };
  };
  const cd =
    o && viewCost
      ? (o.capital.byCurve.C?.capital ?? 0) + (o.capital.byCurve.D?.capital ?? 0)
      : null;
  const onlyState = (s: IntelState) =>
    filters.state === s &&
    !filters.flag &&
    !filters.curve &&
    !filters.band &&
    !filters.minIdle &&
    !filters.q;

  return (
    <>
      <PageTitle
        title="Inteligência do estoque"
        description="Diagnóstico calculado pelo BIOMIE com o estoque, as vendas e as movimentações do Omie. Leitura apenas: nada aqui compra, transfere ou muda preço."
      />
      <Status
        loading={overview.isPending || caps.isPending}
        error={overview.error || caps.error}
        retry={() => {
          overview.refetch();
          caps.refetch();
        }}
      />
      {o && caps.data && (
        <div
          className={`flex flex-col gap-7 transition-opacity ${overview.isPlaceholderData ? "opacity-60" : ""}`}
          aria-busy={overview.isFetching}
        >
          <RunInfo o={o} isSuper={isSuper} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            {viewCost && (
              <StatTile
                label="Capital em estoque"
                value={o.capital.total === null ? "—" : compactMoney(o.capital.total)}
                foot={`${money(o.capital.total)} · saldos positivos × CMC`}
              />
            )}
            {viewCost && (
              <StatTile
                label="Capital em C + D"
                value={cd === null ? "—" : compactMoney(cd)}
                foot={`${percentText(o.capital.cdShare)} do capital · ${label}`}
              />
            )}
            {hasRun && (
              <>
                <StatTile
                  label="Risco de ruptura"
                  value={integer(tile("risco_ruptura").products)}
                  foot="Saldo para menos de 15 dias"
                  active={onlyState("risco_ruptura")}
                  onSelect={() => drill({ state: "risco_ruptura" })}
                />
                <StatTile
                  label="Sem venda há mais de 180 dias"
                  value={integer(over180Products)}
                  foot={
                    over180Capital === null ? "Produtos com saldo" : compactMoney(over180Capital)
                  }
                  active={filters.minIdle === 180 && !filters.state && !filters.band}
                  onSelect={() => drill({ minIdle: 180 })}
                />
                <StatTile
                  label="Produtos novos"
                  value={integer(tile("novo").products)}
                  foot={tile("novo").foot ?? "Sem alerta de encalhe"}
                  active={onlyState("novo")}
                  onSelect={() => drill({ state: "novo" })}
                />
                <StatTile
                  label="Histórico insuficiente"
                  value={integer(tile("historico_insuficiente").products)}
                  foot={tile("historico_insuficiente").foot ?? "Ainda sem base para afirmar"}
                  active={onlyState("historico_insuficiente")}
                  onSelect={() => drill({ state: "historico_insuficiente" })}
                />
              </>
            )}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <CurveChart
              overview={o}
              viewCost={viewCost}
              windowLabel={label}
              onSelect={(curve: ClassifiedCurve) =>
                navigate({
                  to: "/estoque/posicoes",
                  search: (prev) => ({ ...prev, curve, view: "product" }),
                })
              }
            />
            {hasRun ? (
              <IdleRadar
                overview={o}
                viewCost={viewCost}
                onSelect={(band: IntelBand) => drill({ band })}
              />
            ) : (
              <section className="panel flex min-h-60 flex-col items-center justify-center gap-3 p-8 text-center">
                <Lightbulb className="size-9 text-muted-foreground" aria-hidden />
                <h2 className="text-base font-semibold">Nenhuma análise publicada ainda</h2>
                <p className="max-w-md text-sm text-muted-foreground">
                  O radar, os estados e a lista de produtos aparecem depois da primeira execução do
                  motor de inteligência.
                </p>
              </section>
            )}
          </div>

          {hasRun && (
            <div className="grid gap-5 lg:grid-cols-2">
              <StatesList
                overview={o}
                viewCost={viewCost}
                active={filters.state}
                onSelect={(state) => drill({ state })}
              />
              <EvolutionChart overview={o} viewCost={viewCost} />
            </div>
          )}

          {viewCost &&
            (single ? (
              pareto.data ? (
                <ParetoView pareto={pareto.data} windowLabel={label} />
              ) : (
                <Status
                  loading={pareto.isPending}
                  error={pareto.error}
                  retry={() => pareto.refetch()}
                />
              )
            ) : (
              <p className="panel p-5 text-sm text-muted-foreground">
                Pareto do faturamento: escolha uma empresa no topo. A curva é calculada por empresa.
              </p>
            ))}

          {hasRun && (
            <IntelTable
              companyId={companyId}
              filters={filters}
              onChange={update}
              onOpen={(r: IntelProductRow) =>
                setItem({ companyId: r.companyId, omieProductId: r.omieProductId })
              }
              viewCost={viewCost}
              canExport={canExport}
            />
          )}
        </div>
      )}
      <IntelProductSheet item={item} onClose={() => setItem(null)} viewCost={viewCost} />
    </>
  );
}
