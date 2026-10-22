import { useCapabilities, useStockCompany } from "../lib/hooks";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Download, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { stockApi } from "../api";
import type { ClassifiedCurve, Curve, PositionQuery, StockPosition } from "../api/contract";
import { ALL_CURVES } from "../lib/simulation";
import { quantity, money, errorMessage, downloadCsv, dateTime } from "../lib/format";
import {
  AGING_BANDS,
  WINDOW_LABELS,
  incompleteLabel,
  lastSaleText,
  operationLabel,
  percent,
  shortDate,
} from "../lib/curves";
import { PageTitle } from "../components/StockLayout";
import { Choice, CurveBadge, Status, Notice } from "../components/shared";
const route = getRouteApi("/_authenticated/_shell/estoque/posicoes");

type Flag =
  "none" | "onlyNew" | "onlyIncomplete" | "onlyConfirmed" | "soldElsewhere" | "onlyManual";
const FLAGS: { value: Flag; label: string }[] = [
  { value: "none", label: "Todos" },
  { value: "onlyConfirmed", label: "Sem venda confirmada" },
  { value: "onlyIncomplete", label: "Histórico incompleto" },
  { value: "onlyNew", label: "Produto novo" },
  { value: "soldElsewhere", label: "Vendido por outra empresa" },
  { value: "onlyManual", label: "Curva manual" },
];
const MIN_REASON = 10;

function Indicators({ p }: { p: StockPosition }) {
  return (
    <div className="flex max-w-56 flex-wrap gap-1">
      {p.isNew && (
        <Badge variant="secondary" title={`Chegada em ${shortDate(p.arrivedOn)}`}>
          Produto novo
        </Badge>
      )}
      {p.incompleteHistory && (
        <Badge variant="outline" title={incompleteLabel(p.incompleteHistory, p)}>
          Histórico incompleto
        </Badge>
      )}
      {p.soldElsewhere && (
        <Badge
          variant="outline"
          title={`Mesma SKU vendida por ${p.soldElsewhere.companyName}${p.soldElsewhere.lastSale ? ` em ${shortDate(p.soldElsewhere.lastSale)}` : ""}`}
        >
          Vendido por {p.soldElsewhere.companyName}
        </Badge>
      )}
    </div>
  );
}

export function PositionsPage() {
  const incoming = route.useSearch();
  const navigate = route.useNavigate();
  const { companyId, window } = useStockCompany(),
    client = useQueryClient(),
    caps = useCapabilities();
  const initialFlag: Flag = incoming.onlyNew
    ? "onlyNew"
    : incoming.onlyIncomplete
      ? "onlyIncomplete"
      : incoming.onlyConfirmed
        ? "onlyConfirmed"
        : incoming.soldElsewhere
          ? "soldElsewhere"
          : incoming.onlyManual
            ? "onlyManual"
            : "none";
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [hideZero, setHideZero] = useState(true),
    [belowMin, setBelowMin] = useState(incoming.belowMin ?? false),
    [curve, setCurve] = useState<Curve | "all">(incoming.curve ?? "all"),
    [local, setLocal] = useState("all"),
    [family, setFamily] = useState("all"),
    [negative, setNegative] = useState(incoming.onlyNegative ?? false),
    [view, setView] = useState<"position" | "product">(incoming.view ?? "position"),
    [minDays, setMinDays] = useState<string>(
      incoming.minDaysWithoutSale ? String(incoming.minDaysWithoutSale) : "all",
    ),
    [flag, setFlag] = useState<Flag>(initialFlag),
    [sort, setSort] = useState("costValue"),
    [dir, setDir] = useState<"asc" | "desc">("desc"),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [dialog, setDialog] = useState(false),
    [newCurve, setNewCurve] = useState<ClassifiedCurve | "AUTO">("A"),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  // A busca só consulta o servidor 300 ms depois da última tecla.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  // Outra empresa, janela ou visão: volta para a primeira página e limpa a seleção.
  useEffect(() => {
    setPage(0);
    setSelected([]);
  }, [companyId, window, view]);
  const query: PositionQuery = {
    companyId,
    window,
    view,
    search: debounced || undefined,
    curve,
    locationCode: local === "all" ? undefined : local,
    family: family === "all" ? undefined : family,
    onlyNegative: negative,
    hideZero: hideZero && !negative,
    belowMin,
    minDaysWithoutSale:
      minDays === "all" ? undefined : (Number(minDays) as PositionQuery["minDaysWithoutSale"]),
    onlyNew: flag === "onlyNew" || undefined,
    onlyIncomplete: flag === "onlyIncomplete" || undefined,
    onlyConfirmed: flag === "onlyConfirmed" || undefined,
    soldElsewhere: flag === "soldElsewhere" || undefined,
    onlyManual: flag === "onlyManual" || undefined,
    productId: incoming.productId,
    sortBy: sort as PositionQuery["sortBy"],
    sortDir: dir,
    page,
  };
  const q = useQuery({
    queryKey: ["stock", "positions", query],
    queryFn: () => stockApi.positions(query),
    retry: false,
  });
  const options = useQuery({
    queryKey: ["stock", "options", companyId],
    queryFn: () => stockApi.filterOptions(companyId),
    retry: false,
  });
  const read = useQuery({
    queryKey: ["stock", "overview", companyId, window],
    queryFn: () => stockApi.overview(companyId, window),
    retry: false,
  });
  const data = q.data;
  const selectedHere = selected.filter((id) => data?.rows.some((p) => p.id === id));
  const reasonOk = newCurve === "AUTO" || reason.trim().length >= MIN_REASON;
  function reset() {
    setPage(0);
    setSelected([]);
  }
  async function classify() {
    setBusy(true);
    try {
      const r = await stockApi.setCurve({
        positionIds: selectedHere,
        curve: newCurve,
        reason: reason.trim() || undefined,
      });
      toast.success(
        newCurve === "AUTO"
          ? `${r.updated} posições voltaram para a curva automática.`
          : `${r.updated} posições com curva manual ${newCurve}.`,
      );
      setDialog(false);
      setSelected([]);
      setReason("");
      client.invalidateQueries({ queryKey: ["stock"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const viewCost = caps.data?.viewCost === true;
  const label = WINDOW_LABELS[window];
  return (
    <>
      <PageTitle
        title="Posições de estoque"
        description={`${view === "product" ? "Por produto (todos os locais somados)" : "Produto × local"} · curva de ${label}`}
      >
        {caps.data?.export && (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await stockApi.exportCsv({ kind: "positions", query });
                downloadCsv(r.fileName, r.csv);
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Download className="size-4" />
            Exportar CSV
          </Button>
        )}
      </PageTitle>
      {read.data?.readings.some((r) => r.status === "stale") && (
        <Notice>Leitura com mais de 6 horas. Os números podem estar desatualizados.</Notice>
      )}
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Produto ou SKU</span>
          <Input
            aria-label="Buscar produto ou SKU"
            className="h-11 bg-card"
            placeholder="Buscar produto ou SKU"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
          />
        </label>
        <Choice
          label={`Curva (${label})`}
          value={curve}
          onChange={(v) => {
            setCurve(v as Curve | "all");
            reset();
          }}
          options={[
            { value: "all", label: "Todas" },
            ...ALL_CURVES.map((c) => ({ value: c, label: c === "U" ? "Sem curva" : c })),
          ]}
        />
        <Choice
          label="Local"
          value={local}
          onChange={(v) => {
            setLocal(v);
            reset();
          }}
          options={[
            { value: "all", label: "Todos os locais" },
            ...(options.data?.locations ?? []).map((l) => ({
              value: l.code,
              label: l.name ?? l.code,
            })),
          ]}
        />
        <Choice
          label="Família"
          value={family}
          onChange={(v) => {
            setFamily(v);
            reset();
          }}
          options={[
            { value: "all", label: "Todas as famílias" },
            ...(options.data?.families ?? []).map((f) => ({ value: f, label: f })),
          ]}
        />
        <Choice
          label="Ordenar por"
          value={viewCost ? sort : ["costValue", "windowRevenue"].includes(sort) ? "name" : sort}
          onChange={(v) => {
            setSort(v);
            reset();
          }}
          options={[
            ...(viewCost
              ? [
                  { value: "costValue", label: "Valor a custo" },
                  { value: "windowRevenue", label: `Faturamento em ${label}` },
                ]
              : []),
            { value: "daysWithoutSale", label: "Dias sem venda" },
            { value: "lastSale", label: "Última venda" },
            { value: "physicalQty", label: "Quantidade física" },
            { value: "name", label: "Produto" },
            { value: "sku", label: "SKU" },
          ]}
        />
      </div>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0 space-y-1.5">
          <span className="block text-xs font-medium text-muted-foreground">Ver</span>
          <ToggleGroup
            type="single"
            variant="outline"
            value={view}
            onValueChange={(v) => (v === "product" || v === "position") && setView(v)}
            aria-label="Ver por produto ou por local"
            className="justify-start"
          >
            <ToggleGroupItem value="product" className="min-h-11 px-3">
              Por produto
            </ToggleGroupItem>
            <ToggleGroupItem value="position" className="min-h-11 px-3">
              Por local
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Choice
          label="Tempo sem venda"
          value={minDays}
          onChange={(v) => {
            setMinDays(v);
            reset();
          }}
          options={[
            { value: "all", label: "Todos" },
            ...AGING_BANDS.map((b) => ({
              value: String(b.days),
              label: `${b.days}+ dias · ${b.label}`,
            })),
          ]}
        />
        <Choice
          label="Indicador"
          value={flag}
          onChange={(v) => {
            setFlag(v as Flag);
            reset();
          }}
          options={FLAGS}
        />
        <Choice
          label="Ordem"
          value={dir}
          onChange={(v) => {
            setDir(v as "asc" | "desc");
            reset();
          }}
          options={[
            { value: "desc", label: "Decrescente" },
            { value: "asc", label: "Crescente" },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={negative}
            onCheckedChange={(v) => {
              setNegative(v === true);
              reset();
            }}
          />
          Só saldos negativos
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={belowMin}
            onCheckedChange={(v) => {
              setBelowMin(v === true);
              reset();
            }}
          />
          Abaixo do mínimo
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={hideZero && !negative}
            disabled={negative}
            onCheckedChange={(v) => {
              setHideZero(v === true);
              reset();
            }}
          />
          Ocultar posições zeradas
        </label>
        {incoming.productId && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            Produto: {data?.rows[0]?.name ?? "selecionado"}
            <Button
              variant="link"
              className="h-auto min-h-11 px-1"
              onClick={() =>
                navigate({ search: (prev) => ({ ...prev, productId: undefined }), replace: true })
              }
            >
              Limpar filtro
            </Button>
          </p>
        )}
        {caps.data?.classify && selectedHere.length > 0 && (
          <Button onClick={() => setDialog(true)} className="min-h-11">
            Classificar {selectedHere.length} selecionadas
          </Button>
        )}
      </div>
      <Status
        loading={q.isPending || caps.isPending}
        error={q.error || caps.error || options.error}
        empty={read.data?.totals.positions === 0}
        retry={() => {
          q.refetch();
          caps.refetch();
          options.refetch();
          read.refetch();
        }}
      />
      {data && caps.data && read.data?.totals.positions !== 0 && (
        <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
          <Table className="min-w-[1400px]">
            <TableHeader>
              <TableRow>
                {caps.data.classify && (
                  <TableHead className="w-12">
                    <Checkbox
                      aria-label="Selecionar todas as linhas desta página"
                      checked={data.rows.length > 0 && selectedHere.length === data.rows.length}
                      onCheckedChange={(v) =>
                        setSelected(v === true ? data.rows.map((p) => p.id) : [])
                      }
                    />
                  </TableHead>
                )}
                <TableHead>Produto / SKU</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>{view === "product" ? "Família / Locais" : "Família / Local"}</TableHead>
                <TableHead>Curva · {label}</TableHead>
                <TableHead className="text-right">Físico</TableHead>
                {caps.data.viewCost && (
                  <>
                    <TableHead className="text-right">CMC</TableHead>
                    <TableHead className="text-right">Valor a custo</TableHead>
                    <TableHead className="text-right">Faturamento · {label}</TableHead>
                    <TableHead className="text-right">Preço de venda</TableHead>
                  </>
                )}
                <TableHead>Última venda</TableHead>
                <TableHead>Última entrada</TableHead>
                <TableHead>Indicadores</TableHead>
                <TableHead className="text-right">Reservado</TableHead>
                <TableHead className="text-right">Pendente</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((p) => (
                <TableRow key={p.id}>
                  {caps.data?.classify && (
                    <TableCell>
                      <Checkbox
                        aria-label={`Selecionar ${p.name}${p.locationName ? ` em ${p.locationName}` : ""}`}
                        checked={selectedHere.includes(p.id)}
                        onCheckedChange={(v) =>
                          setSelected(
                            v === true
                              ? [...selectedHere, p.id]
                              : selectedHere.filter((id) => id !== p.id),
                          )
                        }
                      />
                    </TableCell>
                  )}
                  <TableCell className="min-w-56 whitespace-normal">
                    {p.productId ? (
                      <Link
                        to="/produtos/$productId"
                        params={{ productId: p.productId }}
                        search={(prev) => ({ ...prev, company: p.companyId })}
                        className="font-medium hover:underline"
                      >
                        {p.name}
                      </Link>
                    ) : (
                      <p className="font-medium">{p.name}</p>
                    )}
                    <p className="text-xs text-muted-foreground">{p.sku}</p>
                  </TableCell>
                  <TableCell className="max-w-44 whitespace-normal text-xs">
                    {p.companyName}
                  </TableCell>
                  <TableCell>
                    <p>{p.family ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.locationCode === "*"
                        ? `${p.locations ?? 0} ${p.locations === 1 ? "local" : "locais"}`
                        : (p.locationName ?? p.locationCode)}
                    </p>
                  </TableCell>
                  <TableCell>
                    <CurveBadge curve={p.curve} />
                    {p.curveSource === "manual" && (
                      <span
                        className="mt-1 block max-w-48 whitespace-normal text-xs text-muted-foreground"
                        title={p.curveReason ?? undefined}
                      >
                        Manual · {p.curveSetBy ?? "—"} · {dateTime(p.curveSetAt ?? null)}
                        {p.curveReason ? ` · “${p.curveReason}”` : ""}
                      </span>
                    )}
                    {caps.data?.viewCost &&
                      p.curveSource === "auto" &&
                      (p.windowShare ?? 0) > 0 && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {percent(p.windowShare)} do faturamento
                        </span>
                      )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {quantity(p.physicalQty)}
                    {p.physicalQty < 0 && (
                      <span className="block text-xs font-medium text-destructive">
                        Saldo negativo
                      </span>
                    )}
                    {typeof p.minQty === "number" && p.minQty > 0 && (
                      <span
                        className={
                          p.physicalQty < p.minQty
                            ? "block text-xs font-medium text-destructive"
                            : "block text-xs text-muted-foreground"
                        }
                      >
                        mín. {quantity(p.minQty)}
                      </span>
                    )}
                  </TableCell>
                  {caps.data?.viewCost && (
                    <>
                      <TableCell className="text-right tabular-nums">{money(p.unitCost)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(p.costValue)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.windowRevenue === null || p.windowRevenue === undefined
                          ? "—"
                          : money(p.windowRevenue)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.salePrice === 0 ? "Não informado" : money(p.salePrice)}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="min-w-40 whitespace-normal text-xs">
                    {lastSaleText(p)}
                  </TableCell>
                  <TableCell className="min-w-36 whitespace-normal text-xs">
                    {p.lastEntry ? (
                      <>
                        {shortDate(p.lastEntry)}
                        <span className="block text-muted-foreground">
                          {operationLabel(p.lastEntryOperation)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Indicators p={p} />
                  </TableCell>
                  <TableCell className="text-right">{quantity(p.reservedQty)}</TableCell>
                  <TableCell className="text-right">{quantity(p.pendingQty)}</TableCell>
                </TableRow>
              ))}
              {data.total === 0 && (
                <TableRow>
                  <TableCell colSpan={16} className="py-10 text-center">
                    Nenhuma posição para estes filtros.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm">
            <p aria-live="polite">
              {data.total}{" "}
              {view === "product"
                ? data.total === 1
                  ? "produto"
                  : "produtos"
                : data.total === 1
                  ? "posição"
                  : "posições"}{" "}
              · página {page + 1} de {Math.max(1, Math.ceil(data.total / 100))}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label="Página anterior"
                disabled={page === 0}
                onClick={() => {
                  setPage(page - 1);
                  setSelected([]);
                }}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label="Próxima página"
                disabled={(page + 1) * 100 >= data.total}
                onClick={() => {
                  setPage(page + 1);
                  setSelected([]);
                }}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      )}
      <Dialog
        open={dialog}
        onOpenChange={(open) => {
          setDialog(open);
          if (!open) setReason("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Classificar curvas</DialogTitle>
            <DialogDescription>
              A curva vale para o produto inteiro nesta empresa, em todos os locais e em todas as
              janelas, até alguém voltar para a automática. Fica registrado quem mudou, quando e por
              quê.
            </DialogDescription>
          </DialogHeader>
          <Choice
            label="Nova curva"
            value={newCurve}
            onChange={(v) => setNewCurve(v as ClassifiedCurve | "AUTO")}
            options={[
              ...(["A", "B", "C", "D"] as const).map((c) => ({
                value: c,
                label: `Curva ${c} (manual)`,
              })),
              { value: "AUTO", label: "Automática (voltar ao cálculo)" },
            ]}
          />
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground">
              Justificativa{" "}
              {newCurve === "AUTO" ? "(opcional)" : `(obrigatória, ${MIN_REASON} a 300 caracteres)`}
            </span>
            <Textarea
              aria-label="Justificativa da curva"
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                newCurve === "AUTO"
                  ? "Ex.: produto voltou a girar normalmente"
                  : "Ex.: produto estratégico para licitação, manter em reposição"
              }
            />
            <span className="block text-xs text-muted-foreground">{reason.trim().length}/300</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(false)}>
              Cancelar
            </Button>
            <Button disabled={busy || !reasonOk} onClick={classify}>
              Confirmar classificação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
