import { useCapabilities, useStockCompany } from "../lib/hooks";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Download, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { Curve, PositionQuery } from "../api/contract";
import { ALL_CURVES } from "../lib/simulation";
import { quantity, money, errorMessage, downloadCsv } from "../lib/format";
import { PageTitle } from "../components/StockLayout";
import { Choice, CurveBadge, Status, Notice } from "../components/shared";
const route = getRouteApi("/_authenticated/_shell/estoque/posicoes");

export function PositionsPage() {
  const incoming = route.useSearch();
  const navigate = route.useNavigate();
  const { companyId } = useStockCompany(),
    client = useQueryClient(),
    caps = useCapabilities();
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [hideZero, setHideZero] = useState(true),
    [belowMin, setBelowMin] = useState(incoming.belowMin ?? false),
    [curve, setCurve] = useState<Curve | "all">(incoming.curve ?? "all"),
    [local, setLocal] = useState("all"),
    [family, setFamily] = useState("all"),
    [negative, setNegative] = useState(incoming.onlyNegative ?? false),
    [sort, setSort] = useState("costValue"),
    [dir, setDir] = useState<"asc" | "desc">("desc"),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [dialog, setDialog] = useState(false),
    [newCurve, setNewCurve] = useState<Curve>("A"),
    [busy, setBusy] = useState(false);
  // A busca só consulta o servidor 300 ms depois da última tecla.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  // Outra empresa: volta para a primeira página e limpa a seleção.
  useEffect(() => {
    setPage(0);
    setSelected([]);
  }, [companyId]);
  const query: PositionQuery = {
    companyId,
    search: debounced || undefined,
    curve,
    locationCode: local === "all" ? undefined : local,
    family: family === "all" ? undefined : family,
    onlyNegative: negative,
    hideZero: hideZero && !negative,
    belowMin,
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
    queryKey: ["stock", "overview", companyId],
    queryFn: () => stockApi.overview(companyId),
    retry: false,
  });
  const data = q.data;
  const selectedHere = selected.filter((id) => data?.rows.some((p) => p.id === id));
  function reset() {
    setPage(0);
    setSelected([]);
  }
  async function classify() {
    setBusy(true);
    try {
      const r = await stockApi.setCurve({ positionIds: selectedHere, curve: newCurve });
      toast.success(`${r.updated} posições classificadas.`);
      setDialog(false);
      setSelected([]);
      client.invalidateQueries({ queryKey: ["stock"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        title="Posições de estoque"
        description="Produto × local · classificação manual por empresa"
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
          label="Curva"
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
          value={caps.data?.viewCost ? sort : sort === "costValue" ? "name" : sort}
          onChange={(v) => {
            setSort(v);
            reset();
          }}
          options={[
            ...(caps.data?.viewCost ? [{ value: "costValue", label: "Valor a custo" }] : []),
            { value: "physicalQty", label: "Quantidade física" },
            { value: "name", label: "Produto" },
            { value: "sku", label: "SKU" },
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
            checked={curve === "U"}
            onCheckedChange={(v) => {
              setCurve(v === true ? "U" : "all");
              reset();
            }}
          />
          Só sem curva
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
        <div className="w-44">
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
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                {caps.data.classify && (
                  <TableHead className="w-12">
                    <Checkbox
                      aria-label="Selecionar todas as posições desta página"
                      checked={data.rows.length > 0 && selectedHere.length === data.rows.length}
                      onCheckedChange={(v) =>
                        setSelected(v === true ? data.rows.map((p) => p.id) : [])
                      }
                    />
                  </TableHead>
                )}
                <TableHead>Produto / SKU</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Família / Local</TableHead>
                <TableHead>Curva</TableHead>
                <TableHead className="text-right">Físico</TableHead>
                {caps.data.viewCost && (
                  <>
                    <TableHead className="text-right">CMC</TableHead>
                    <TableHead className="text-right">Valor a custo</TableHead>
                    <TableHead className="text-right">Preço de venda</TableHead>
                  </>
                )}
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
                        aria-label={`Selecionar ${p.name} em ${p.locationName}`}
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
                      {p.locationName ?? p.locationCode}
                    </p>
                  </TableCell>
                  <TableCell>
                    <CurveBadge curve={p.curve} />
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
                        {p.salePrice === 0 ? "Não informado" : money(p.salePrice)}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right">{quantity(p.reservedQty)}</TableCell>
                  <TableCell className="text-right">{quantity(p.pendingQty)}</TableCell>
                </TableRow>
              ))}
              {data.total === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="py-10 text-center">
                    Nenhuma posição para estes filtros.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm">
            <p aria-live="polite">
              {data.total} posições · página {page + 1} de{" "}
              {Math.max(1, Math.ceil(data.total / 100))}
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
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Classificar curvas</DialogTitle>
            <DialogDescription>
              A curva vale para o produto inteiro nesta empresa. Todos os locais dos produtos
              selecionados serão atualizados.
            </DialogDescription>
          </DialogHeader>
          <Choice
            label="Nova curva"
            value={newCurve}
            onChange={(v) => setNewCurve(v as Curve)}
            options={ALL_CURVES.map((c) => ({
              value: c,
              label: c === "U" ? "Sem curva" : `Curva ${c}`,
            }))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(false)}>
              Cancelar
            </Button>
            <Button disabled={busy} onClick={classify}>
              Confirmar classificação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
