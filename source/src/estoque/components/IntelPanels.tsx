/**
 * Abas da Inteligência do Estoque além do painel: Alertas (fase 3), Reposição Inteligente e Entre
 * empresas (fase 5) e a matriz risco × impacto. Tudo é consultivo: ciência e parâmetros de reposição
 * ficam na auditoria; nada aqui compra, transfere, muda preço ou escreve no Omie.
 */
import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Download, Pencil, Truck } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { CompanyFilter } from "../api/contract";
import {
  SERVICE_LEVELS,
  type IntelAlert,
  type IntelSeverity,
  type ReplenishmentRow,
  type ReplenishmentStatus,
  type ServiceLevel,
} from "../api/intel-contract";
import { intelApi } from "../api/intel";
import { suppliersApi } from "../api/suppliers";
import { useStockCompany } from "../lib/hooks";
import { dateTime, downloadCsv, errorMessage, money, quantity } from "../lib/format";
import { CURVE_COLORS, STATE_LABELS, compactMoney, compactNumber, integer } from "../lib/intel";
import {
  QUALITY_LABELS,
  REPLENISHMENT_LABELS,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
} from "../lib/intel-insights";
import { Choice, CurveBadge, Notice, Status } from "./shared";
import { StatTile, StateBadge, TipBox } from "./IntelBits";
import { AlertRows } from "./IntelInsights";
import { useAlertRefresh } from "../lib/intel-hooks";
import { ChartCard, CurveLegend } from "./IntelCharts";
import type { IntelItem } from "./IntelProductSheet";

const ALL = "all";
type TipProps = { active?: boolean | undefined; payload?: { payload?: unknown }[] | undefined };
const PAGE = 50;

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm">
      <p aria-live="polite">
        {integer(total)} {total === 1 ? "item" : "itens"} · página {page + 1} de {pages}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="icon"
          className="min-h-11 min-w-11"
          aria-label="Página anterior"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="min-h-11 min-w-11"
          aria-label="Próxima página"
          disabled={(page + 1) * PAGE >= total}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- alertas

export function AlertsPanel({
  companyId,
  canAck,
  onOpen,
}: {
  companyId: CompanyFilter;
  canAck: boolean;
  onOpen: (item: IntelItem) => void;
}) {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [severity, setSeverity] = useState<IntelSeverity | undefined>(undefined);
  const [onlyNew, setOnlyNew] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const refresh = useAlertRefresh();
  const query = {
    companyId,
    status,
    severity,
    onlyNew: onlyNew || undefined,
    search: search.trim() || undefined,
    page,
  };
  const q = useQuery({
    queryKey: ["stock", "intel", "alerts", query],
    queryFn: () => intelApi.alerts(query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const s = q.data?.summary;
  const reset = () => setPage(0);
  return (
    <section className="min-w-0 space-y-5">
      <p className="text-sm text-muted-foreground">
        Situações incomuns que as regras do motor encontraram (queda abrupta de vendas, entrada
        acima da demanda, saldo negativo, custo que mudou, produto que parou de vender e outras). O
        mesmo problema não vira um aviso novo a cada análise: ele fica aberto, aparece como
        “gravidade mudou” quando piora ou melhora e é resolvido quando a regra deixa de encontrá-lo.
      </p>
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile
            label="Alertas abertos"
            value={integer(s.open)}
            foot={`${integer(s.acknowledged)} com ciência`}
          />
          <StatTile
            label="Gravidade alta"
            value={integer(s.alta)}
            active={severity === "alta"}
            onSelect={() => {
              setSeverity(severity === "alta" ? undefined : "alta");
              reset();
            }}
          />
          <StatTile
            label="Gravidade média"
            value={integer(s.media)}
            active={severity === "media"}
            onSelect={() => {
              setSeverity(severity === "media" ? undefined : "media");
              reset();
            }}
          />
          <StatTile
            label="Novos na última análise"
            value={integer(s.new)}
            active={onlyNew}
            onSelect={() => {
              setOnlyNew(!onlyNew);
              reset();
            }}
          />
          <StatTile label="Gravidade mudou" value={integer(s.changed)} foot="Na última análise" />
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="w-64 min-w-0 space-y-1.5">
          <span className="block text-xs font-medium text-muted-foreground">Buscar</span>
          <Input
            value={search}
            maxLength={120}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
            placeholder="SKU ou nome do produto"
            className="h-11 bg-card"
          />
        </label>
        <div className="w-48">
          <Choice
            label="Situação"
            value={status}
            onChange={(v) => {
              setStatus(v as "open" | "resolved" | "all");
              reset();
            }}
            options={[
              { value: "open", label: "Abertos" },
              { value: "resolved", label: "Resolvidos" },
              { value: "all", label: "Todos" },
            ]}
          />
        </div>
        <div className="w-48">
          <Choice
            label="Gravidade"
            value={severity ?? ALL}
            onChange={(v) => {
              setSeverity(v === ALL ? undefined : (v as IntelSeverity));
              reset();
            }}
            options={[
              { value: ALL, label: "Todas" },
              ...SEVERITY_ORDER.map((x) => ({ value: x, label: SEVERITY_LABELS[x] })),
            ]}
          />
        </div>
      </div>
      <Status loading={q.isPending} error={q.error} retry={() => q.refetch()} />
      {q.data && (
        <div className={`space-y-3 ${q.isPlaceholderData ? "opacity-60" : ""}`}>
          <AlertRows
            alerts={q.data.rows}
            canAck={canAck}
            showProduct
            onChanged={refresh}
            onOpenProduct={(a: IntelAlert) =>
              onOpen({ companyId: a.companyId, omieProductId: a.omieProductId })
            }
          />
          {q.data.total > PAGE && (
            <div className="panel">
              <Pager page={page} total={q.data.total} onPage={setPage} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- reposição

const STATUS_FILTERS: (ReplenishmentStatus | "all")[] = [
  "comprar",
  "aguardar",
  "nao_comprar",
  "sem_fornecedor",
  "fornecedor_indefinido",
  "sem_prazo",
  "sem_previsao",
  "sem_demanda",
  "all",
];

function CoverageVsLeadTime({ rows }: { rows: ReplenishmentRow[] }) {
  const data = rows
    .filter((r) => r.status === "comprar" && r.coverageDays !== undefined && r.leadTimeDays)
    .slice(0, 15)
    .map((r) => ({
      label: (r.sku ?? r.name ?? r.omieProductId).slice(0, 24),
      name: r.name,
      coverage: r.coverageDays ?? 0,
      lead: r.leadTimeDays ?? 0,
    }));
  if (data.length === 0) return null;
  return (
    <ChartCard
      title="Cobertura × prazo de reposição"
      description="Azul: dias que o disponível + pendente dura na demanda prevista; laranja: prazo do fornecedor. Barra menor que o prazo: falta antes da entrega se não comprar agora."
    >
      <ChartContainer
        config={{ coverage: { label: "Cobertura" }, lead: { label: "Prazo" } }}
        className="aspect-auto w-full"
        style={{ height: Math.max(180, data.length * 30 + 40) }}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
          accessibilityLayer
        >
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={compactNumber} />
          <YAxis type="category" dataKey="label" width={140} tickLine={false} axisLine={false} />
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            content={(props: TipProps) => {
              const r = props.active
                ? (props.payload?.[0]?.payload as (typeof data)[number] | undefined)
                : undefined;
              if (!r) return null;
              return (
                <TipBox
                  title={r.name ?? r.label}
                  rows={[
                    {
                      key: "c",
                      label: "dias de cobertura",
                      value: quantity(r.coverage),
                      color: "var(--chart-1)",
                    },
                    {
                      key: "l",
                      label: "dias de prazo",
                      value: quantity(r.lead),
                      color: "var(--age-3)",
                    },
                  ]}
                />
              );
            }}
          />
          <Bar
            dataKey="coverage"
            fill="var(--chart-1)"
            radius={[0, 3, 3, 0]}
            maxBarSize={10}
            isAnimationActive={false}
          />
          <Bar
            dataKey="lead"
            fill="var(--age-3)"
            radius={[0, 3, 3, 0]}
            maxBarSize={10}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

interface PolicyDraft {
  reviewDays: string;
  serviceLevel: ServiceLevel;
  maxCoverageDays: string;
  note: string;
}

/**
 * Política de reposição da empresa (0049): ciclo de revisão, nível de serviço e cobertura máxima, de
 * Compras e do Super admin. Os prazos de entrega ficam em Fornecedores e prazos (por fornecedor e produto).
 */
function PolicySection({ companyId }: { companyId: CompanyFilter }) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["stock", "suppliers", "policies", companyId],
    queryFn: () => suppliersApi.policies(companyId),
    retry: false,
  });
  const [editing, setEditing] = useState<{ companyId: string; draft: PolicyDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
  const d = editing?.draft;
  const review = d ? num(d.reviewDays) : null;
  const maxCov = d ? num(d.maxCoverageDays) : null;
  const valid =
    d !== undefined &&
    review !== null &&
    Number.isInteger(review) &&
    review >= 1 &&
    review <= 180 &&
    (maxCov === null || (Number.isInteger(maxCov) && maxCov >= 7 && maxCov <= 730)) &&
    d.note.trim().length >= 10;
  async function save(values: Parameters<typeof suppliersApi.setPolicy>[0]["values"]) {
    if (!editing || !d) return;
    setBusy(true);
    try {
      await suppliersApi.setPolicy({ companyId: editing.companyId, values, note: d.note.trim() });
      toast.success(
        values
          ? "Política salva. Vale a partir da próxima análise."
          : "Voltou aos padrões do BIOMIE.",
      );
      setEditing(null);
      void client.invalidateQueries({ queryKey: ["stock", "suppliers", "policies"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const defaults = q.data?.defaults;
  return (
    <section className="panel space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Prazos de entrega e política de reposição</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            O prazo de entrega é de cada fornecedor (do produto ou o padrão dele), informado por
            Compras em Fornecedores e prazos. Sem fornecedor ou sem prazo confiável, a quantidade de
            reposição fica indisponível. Ciclo de revisão, nível de serviço e cobertura máxima são
            da empresa.
          </p>
        </div>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/estoque/fornecedores">
            <Truck aria-hidden /> Fornecedores e prazos
          </Link>
        </Button>
      </div>
      <Status loading={q.isPending} error={q.error} retry={() => q.refetch()} />
      {q.data && q.data.testLeadTimesOn && (
        <Notice>
          Homologação: prazos de teste ligados. Prazo configurado na simulação não foi confirmado
          por Compras e não pode servir de base a recomendações reais.
        </Notice>
      )}
      {q.data && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa</TableHead>
                <TableHead className="text-right">Revisão</TableHead>
                <TableHead className="text-right">Nível de serviço</TableHead>
                <TableHead className="text-right">Cobertura máx.</TableHead>
                <TableHead className="text-right">Prazos confirmados</TableHead>
                <TableHead>Origem</TableHead>
                {q.data.canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.companies.map((c) => {
                const p = c.policy;
                const review = p?.reviewDays ?? defaults?.reviewDays ?? 30;
                const level = p?.serviceLevel ?? defaults?.serviceLevel ?? 0.9;
                const cov = p ? p.maxCoverageDays : (defaults?.maxCoverageDays ?? null);
                return (
                  <TableRow key={c.companyId}>
                    <TableCell>{c.companyName}</TableCell>
                    <TableCell className="text-right tabular-nums">{review} dias</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Math.round(level * 100)}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {cov === null ? "—" : `${cov} dias`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {integer(c.confirmedLeadTimes)}
                      {c.testLeadTimes > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          + {integer(c.testLeadTimes)} de teste
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-56 whitespace-normal text-xs text-muted-foreground">
                      {p ? (
                        <>
                          {p.note}
                          <span className="block">
                            {p.updatedBy ? `${p.updatedBy} · ` : ""}
                            {dateTime(p.updatedAt)}
                          </span>
                        </>
                      ) : (
                        "Padrão do BIOMIE (Compras pode ajustar)"
                      )}
                    </TableCell>
                    {q.data.canEdit && (
                      <TableCell className="whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11"
                          aria-label={`Editar a política de ${c.companyName}`}
                          onClick={() =>
                            setEditing({
                              companyId: c.companyId,
                              draft: {
                                reviewDays: String(review),
                                serviceLevel: level as ServiceLevel,
                                maxCoverageDays: cov === null ? "" : String(cov),
                                note: "",
                              },
                            })
                          }
                        >
                          <Pencil aria-hidden />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Política de reposição</DialogTitle>
            <DialogDescription>
              Vale para a empresa inteira, a partir da próxima análise. A mudança fica no histórico
              e na Auditoria, com a observação.
            </DialogDescription>
          </DialogHeader>
          {d && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="block text-xs font-medium text-muted-foreground">
                  Revisão a cada (dias)
                </span>
                <Input
                  inputMode="numeric"
                  value={d.reviewDays}
                  onChange={(e) =>
                    setEditing({ ...editing!, draft: { ...d, reviewDays: e.target.value } })
                  }
                  className="h-11 bg-card"
                />
              </label>
              <Choice
                label="Nível de serviço"
                value={String(d.serviceLevel)}
                onChange={(v) =>
                  setEditing({
                    ...editing!,
                    draft: { ...d, serviceLevel: Number(v) as ServiceLevel },
                  })
                }
                options={SERVICE_LEVELS.map((l) => ({
                  value: String(l),
                  label: `${Math.round(l * 100)}%`,
                }))}
              />
              <label className="space-y-1.5 text-sm">
                <span className="block text-xs font-medium text-muted-foreground">
                  Cobertura máxima em dias (opcional)
                </span>
                <Input
                  inputMode="numeric"
                  value={d.maxCoverageDays}
                  onChange={(e) =>
                    setEditing({ ...editing!, draft: { ...d, maxCoverageDays: e.target.value } })
                  }
                  className="h-11 bg-card"
                />
              </label>
              <label className="space-y-1.5 text-sm sm:col-span-2">
                <span className="block text-xs font-medium text-muted-foreground">
                  Observação (10 a 300 caracteres)
                </span>
                <Textarea
                  value={d.note}
                  maxLength={300}
                  onChange={(e) =>
                    setEditing({ ...editing!, draft: { ...d, note: e.target.value } })
                  }
                />
              </label>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={busy || !d || d.note.trim().length < 10}
              onClick={() => void save(null)}
            >
              Voltar aos padrões
            </Button>
            <Button
              disabled={!valid || busy}
              onClick={() =>
                void save({
                  reviewDays: review!,
                  serviceLevel: d!.serviceLevel,
                  maxCoverageDays: maxCov,
                })
              }
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function ReplenishmentPanel({
  companyId,
  viewCost,
  canExport,
  onOpen,
}: {
  companyId: CompanyFilter;
  viewCost: boolean;
  canExport: boolean;
  onOpen: (item: IntelItem) => void;
}) {
  const { supplier } = useStockCompany();
  const [status, setStatus] = useState<ReplenishmentStatus | "all">("comprar");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const query = { companyId, status, search: search.trim() || undefined, supplier, page };
  const q = useQuery({
    queryKey: ["stock", "intel", "replenishment", query],
    queryFn: () => intelApi.replenishment(query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const s = q.data?.summary;
  const pick = (v: ReplenishmentStatus | "all") => {
    setStatus(v);
    setPage(0);
  };
  return (
    <section className="min-w-0 space-y-5">
      <Notice>
        Sugestões para revisão humana. O BIOMIE não cria pedido de compra no Omie. Quantidade só com
        fornecedor definido, prazo de entrega confirmado por Compras e previsão de demanda aprovada
        no teste histórico.
      </Notice>
      {s && (s.testLeadTime ?? 0) > 0 && (
        <Notice>
          {integer(s.testLeadTime ?? 0)} produto(s) com prazo configurado na simulação
          (homologação). O prazo deve ser confirmado por Compras antes de servir de base a
          recomendações reais.
        </Notice>
      )}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <StatTile
            label="Comprar"
            value={integer(s.comprar)}
            foot={
              viewCost && s.costEstimate !== null
                ? `≈ ${compactMoney(s.costEstimate)} a custo${s.costEstimateMissing ? ` · ${s.costEstimateMissing} sem custo` : ""}`
                : "Produtos no ponto de reposição"
            }
            active={status === "comprar"}
            onSelect={() => pick("comprar")}
          />
          <StatTile
            label="Sem compra neste ciclo"
            value={integer(s.aguardar)}
            active={status === "aguardar"}
            onSelect={() => pick("aguardar")}
          />
          <StatTile
            label="Não comprar agora"
            value={integer(s.naoComprar)}
            active={status === "nao_comprar"}
            onSelect={() => pick("nao_comprar")}
          />
          <StatTile
            label="Sem fornecedor"
            value={integer(s.semFornecedor ?? 0)}
            foot="Nenhum fornecedor vinculado"
            active={status === "sem_fornecedor"}
            onSelect={() => pick("sem_fornecedor")}
          />
          <StatTile
            label="Fornecedor a definir"
            value={integer(s.fornecedorIndefinido ?? 0)}
            foot="Vários com prazo, sem principal"
            active={status === "fornecedor_indefinido"}
            onSelect={() => pick("fornecedor_indefinido")}
          />
          <StatTile
            label="Sem prazo de entrega"
            value={integer(s.semPrazo)}
            active={status === "sem_prazo"}
            onSelect={() => pick("sem_prazo")}
          />
          <StatTile
            label="Sem previsão confiável"
            value={integer(s.semPrevisao)}
            active={status === "sem_previsao"}
            onSelect={() => pick("sem_previsao")}
          />
          <StatTile
            label="Sem demanda prevista"
            value={integer(s.semDemanda)}
            active={status === "sem_demanda"}
            onSelect={() => pick("sem_demanda")}
          />
        </div>
      )}
      <PolicySection companyId={companyId} />
      {q.data && <CoverageVsLeadTime rows={q.data.rows} />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="w-64 min-w-0 space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground">Buscar</span>
            <Input
              value={search}
              maxLength={120}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="SKU ou nome do produto"
              className="h-11 bg-card"
            />
          </label>
          <div className="w-56">
            <Choice
              label="Situação"
              value={status}
              onChange={(v) => pick(v as ReplenishmentStatus | "all")}
              options={STATUS_FILTERS.map((x) => ({
                value: x,
                label: x === "all" ? "Todas" : REPLENISHMENT_LABELS[x],
              }))}
            />
          </div>
        </div>
        {canExport && (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { page: _p, ...rest } = query;
                const r = await intelApi.exportReplenishmentCsv(rest);
                downloadCsv(r.fileName, r.csv);
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Download aria-hidden /> Exportar CSV
          </Button>
        )}
      </div>
      <Status loading={q.isPending} error={q.error} retry={() => q.refetch()} />
      {q.data && (
        <div className={`panel overflow-hidden ${q.isPlaceholderData ? "opacity-60" : ""}`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead className="text-right">Sugestão</TableHead>
                  {viewCost && <TableHead className="text-right">Custo estimado</TableHead>}
                  <TableHead className="text-right">Disp. + pendente</TableHead>
                  <TableHead className="text-right">Demanda/dia</TableHead>
                  <TableHead>Fornecedor e prazo</TableHead>
                  <TableHead className="text-right">Ponto de reposição</TableHead>
                  <TableHead className="text-right">Cobertura</TableHead>
                  <TableHead>Risco e explicação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.rows.map((r) => (
                  <TableRow key={`${r.companyId}:${r.omieProductId}`}>
                    <TableCell className="min-w-56 max-w-72 whitespace-normal">
                      <button
                        type="button"
                        className="text-left font-medium text-primary hover:underline"
                        onClick={() =>
                          onOpen({ companyId: r.companyId, omieProductId: r.omieProductId })
                        }
                      >
                        {r.name ?? r.sku ?? r.omieProductId}
                      </button>
                      <p className="text-xs text-muted-foreground">
                        {[r.sku, companyId === "all" ? r.companyName : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {r.curve && <CurveBadge curve={r.curve} />}
                        <StateBadge state={r.state} className="text-xs" />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {REPLENISHMENT_LABELS[r.status]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.status === "comprar" ? `${quantity(r.qty ?? 0)} un.` : "—"}
                    </TableCell>
                    {viewCost && (
                      <TableCell className="text-right tabular-nums">
                        {r.status !== "comprar"
                          ? "—"
                          : r.costEstimate === null || r.costEstimate === undefined
                            ? "sem custo"
                            : money(r.costEstimate)}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">
                      {r.position === undefined ? "—" : quantity(r.position)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.dailyDemand === undefined
                        ? "—"
                        : quantity(Math.round(r.dailyDemand * 100) / 100)}
                    </TableCell>
                    <TableCell className="min-w-44 whitespace-normal text-xs">
                      {r.supplier ? (
                        <>
                          <span className="font-medium">{r.supplier.name}</span>
                          {r.supplier.leadTimeDays ? (
                            <span className="block tabular-nums">
                              {r.supplier.leadTimeDays} dias corridos
                              {r.supplier.leadTimeSource === "fornecedor" ? " (padrão)" : ""}
                            </span>
                          ) : (
                            <span className="block text-muted-foreground">sem prazo</span>
                          )}
                          {r.supplier.leadTimeStatus === "teste" && (
                            <Badge variant="outline" className="mt-1">
                              Simulação
                            </Badge>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          {r.status === "fornecedor_indefinido"
                            ? `${r.suppliers?.length ?? 0} fornecedores`
                            : "—"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.reorderPoint === undefined ? "—" : quantity(Math.round(r.reorderPoint))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.coverageDays === undefined
                        ? "—"
                        : `${quantity(Math.round(r.coverageDays))} d`}
                    </TableCell>
                    <TableCell className="min-w-72 max-w-md whitespace-normal text-xs">
                      {r.risk && <p>{r.risk}</p>}
                      <p className="text-muted-foreground">{r.explanation ?? r.message}</p>
                      {r.forecastQuality && (
                        <p className="text-muted-foreground">
                          Previsão de qualidade {QUALITY_LABELS[r.forecastQuality].toLowerCase()} no
                          teste histórico.
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {q.data.total === 0 && (
                  <TableRow>
                    <TableCell colSpan={viewCost ? 10 : 9} className="py-10 text-center">
                      Nenhum produto nesta situação.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <Pager page={page} total={q.data.total} onPage={setPage} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- entre empresas

export function OpportunitiesPanel({
  companyId,
  viewCost,
  onOpen,
}: {
  companyId: CompanyFilter;
  viewCost: boolean;
  onOpen: (item: IntelItem) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const query = { companyId, search: search.trim() || undefined, page };
  const q = useQuery({
    queryKey: ["stock", "intel", "opportunities", query],
    queryFn: () => intelApi.opportunities(query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  return (
    <section className="min-w-0 space-y-5">
      <Notice>
        Movimentação entre CNPJs pode exigir nota fiscal e processos fiscais e operacionais
        específicos. O BIOMIE só aponta a oportunidade: não executa transferências nem presume que
        elas são permitidas.
      </Notice>
      <p className="text-sm text-muted-foreground">
        Mesma SKU com sobra numa empresa (excesso, possível obsolescência, sem venda na janela ou
        baixo giro; sobra = disponível − demanda prevista dela em 90 dias) e falta noutra (demanda
        prevista e cobertura abaixo do limite de ruptura, ou sem saldo). Aparecem só as
        oportunidades entre empresas que você acessa.
      </p>
      <label className="block w-64 min-w-0 space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground">Buscar</span>
        <Input
          value={search}
          maxLength={120}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="SKU ou nome do produto"
          className="h-11 bg-card"
        />
      </label>
      <Status loading={q.isPending} error={q.error} retry={() => q.refetch()} />
      {q.data && (
        <div className={`panel overflow-hidden ${q.isPlaceholderData ? "opacity-60" : ""}`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto (SKU)</TableHead>
                  <TableHead>De → para</TableHead>
                  <TableHead className="text-right">Até</TableHead>
                  {viewCost && <TableHead className="text-right">Valor a custo</TableHead>}
                  <TableHead>Por quê</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.rows.map((o) => (
                  <TableRow key={`${o.fromCompanyId}:${o.fromOmie}:${o.toCompanyId}:${o.toOmie}`}>
                    <TableCell className="min-w-48 whitespace-normal">
                      <p className="font-medium">{o.name ?? o.sku}</p>
                      <p className="text-xs text-muted-foreground">{o.sku}</p>
                    </TableCell>
                    <TableCell className="min-w-56 whitespace-normal text-sm">
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() =>
                          onOpen({ companyId: o.fromCompanyId, omieProductId: o.fromOmie })
                        }
                      >
                        {o.fromCompanyName}
                      </button>{" "}
                      ({STATE_LABELS[o.from.state].toLowerCase()}) →{" "}
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() =>
                          onOpen({ companyId: o.toCompanyId, omieProductId: o.toOmie })
                        }
                      >
                        {o.toCompanyName}
                      </button>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{quantity(o.qty)} un.</TableCell>
                    {viewCost && (
                      <TableCell className="text-right tabular-nums">
                        {o.valueAtCost === null || o.valueAtCost === undefined
                          ? "sem custo"
                          : money(o.valueAtCost)}
                      </TableCell>
                    )}
                    <TableCell className="min-w-72 max-w-md whitespace-normal text-xs text-muted-foreground">
                      {o.reason}
                    </TableCell>
                  </TableRow>
                ))}
                {q.data.total === 0 && (
                  <TableRow>
                    <TableCell colSpan={viewCost ? 5 : 4} className="py-10 text-center">
                      Nenhuma oportunidade entre empresas nesta análise.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <Pager page={page} total={q.data.total} onPage={setPage} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- matriz risco × impacto

/** Marcas 1–2–5 × 10ⁿ que cobrem os valores (eixo logarítmico legível: R$ 1 mil, 2 mil, 5 mil…). */
function logTicks(values: number[]): number[] {
  const positive = values.filter((v) => v > 0);
  if (positive.length === 0) return [];
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++)
    for (const m of [1, 2, 5]) out.push(m * 10 ** e);
  const lo = out.filter((t) => t <= min).pop() ?? out[0]!;
  const hi = out.find((t) => t >= max) ?? out[out.length - 1]!;
  return out.filter((t) => t >= lo && t <= hi);
}

export function RiskMatrix({
  companyId,
  onOpen,
}: {
  companyId: CompanyFilter;
  onOpen: (item: IntelItem) => void;
}) {
  const q = useQuery({
    queryKey: ["stock", "intel", "matrix", companyId],
    queryFn: () => intelApi.matrix(companyId),
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (q.isPending || q.error)
    return <Status loading={q.isPending} error={q.error} retry={() => q.refetch()} />;
  const points = (q.data?.points ?? []).map(
    ([company, omie, sku, name, capital, priority, state, curve]) => ({
      company,
      omie,
      sku,
      name,
      capital,
      priority,
      state,
      curve,
      fill: curve ? CURVE_COLORS[curve] : "var(--curve-u)",
    }),
  );
  if (points.length === 0) return null;
  const ticks = logTicks(points.map((p) => p.capital));
  return (
    <ChartCard
      title="Risco × impacto financeiro"
      description={`Os ${integer(points.length)} produtos de maior prioridade com capital${q.data && q.data.total > points.length ? ` (de ${integer(q.data.total)})` : ""}: à direita, mais capital (eixo em escala logarítmica); acima, maior prioridade para liberar capital. Cor = curva. Clique para abrir o produto.`}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead className="text-right">Capital</TableHead>
              <TableHead className="text-right">Prioridade</TableHead>
              <TableHead>Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.slice(0, 50).map((p) => (
              <TableRow key={`${p.company}:${p.omie}`}>
                <TableCell>{p.name ?? p.sku}</TableCell>
                <TableCell className="text-right tabular-nums">{money(p.capital)}</TableCell>
                <TableCell className="text-right tabular-nums">{Math.round(p.priority)}</TableCell>
                <TableCell>{STATE_LABELS[p.state]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      footer="A prioridade é o índice documentado do motor (capital, tempo sem venda, cobertura e queda da demanda), não uma probabilidade."
    >
      <CurveLegend />
      <ChartContainer
        config={{ priority: { label: "Prioridade" } }}
        className="aspect-auto h-80 w-full"
      >
        <ScatterChart margin={{ top: 12, right: 16, bottom: 4, left: 0 }} accessibilityLayer>
          <CartesianGrid stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="capital"
            scale="log"
            domain={[ticks[0] ?? "auto", ticks[ticks.length - 1] ?? "auto"]}
            ticks={ticks}
            tickFormatter={compactMoney}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            name="Capital"
          />
          <YAxis
            type="number"
            dataKey="priority"
            domain={[0, 100]}
            width={36}
            tickLine={false}
            axisLine={false}
            name="Prioridade"
          />
          <ZAxis range={[90, 90]} />
          <ReferenceLine y={50} stroke="var(--muted-foreground)" strokeDasharray="2 3" />
          <ChartTooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={(props: TipProps) => {
              const p = props.active
                ? (props.payload?.[0]?.payload as (typeof points)[number] | undefined)
                : undefined;
              if (!p) return null;
              return (
                <TipBox
                  title={p.name ?? p.sku ?? p.omie}
                  rows={[
                    { key: "c", label: "capital a custo", value: money(p.capital) },
                    { key: "p", label: "prioridade", value: String(Math.round(p.priority)) },
                  ]}
                  note={`${STATE_LABELS[p.state]}${p.curve ? ` · curva ${p.curve}` : ""}`}
                />
              );
            }}
          />
          <Scatter
            data={points}
            isAnimationActive={false}
            onClick={(p: { payload?: { company?: string; omie?: string } }) => {
              if (p.payload?.company && p.payload.omie)
                onOpen({ companyId: p.payload.company, omieProductId: p.payload.omie });
            }}
            className="cursor-pointer"
          >
            {points.map((p) => (
              <Cell key={`${p.company}:${p.omie}`} fill={p.fill} stroke="var(--background)" />
            ))}
          </Scatter>
        </ScatterChart>
      </ChartContainer>
    </ChartCard>
  );
}
