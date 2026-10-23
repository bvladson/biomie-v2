/** Lista de produtos analisados (oportunidades e riscos): filtros na URL, ordenação, páginas e CSV. */
import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronLeft,
  ChevronRight,
  Download,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ClassifiedCurve, CompanyFilter } from "../api/contract";
import type {
  IntelBand,
  IntelMinIdle,
  IntelProductRow,
  IntelQuery,
  IntelSort,
  IntelState,
} from "../api/intel-contract";
import { intelApi } from "../api/intel";
import { downloadCsv, errorMessage, money, quantity } from "../lib/format";
import { shortDate } from "../lib/curves";
import {
  BAND_LABELS,
  BAND_ORDER,
  COST_FLAGS,
  FLAG_LABELS,
  MIN_IDLE,
  STATE_LABELS,
  STATE_ORDER,
  coverageText,
  integer,
  minIdleLabel,
} from "../lib/intel";
import { hasFilters, toQuery, type IntelFilters } from "../lib/intel-search";
import { Choice, CurveBadge, Status } from "./shared";
import { FlagList, PriorityMeter, StateBadge } from "./IntelBits";

const PAGE = 50;
const ALL = "all";

function trendText(v: number | null) {
  if (v === null) return "—";
  const n = Math.round(v);
  return n === 0 ? "estável" : `${n > 0 ? "↑ +" : "↓ "}${integer(n)}%`;
}

function coverage(r: IntelProductRow) {
  if (r.coverageDays !== null) return coverageText(r.coverageDays);
  if ((r.qty ?? 0) <= 0) return "—";
  return r.units365 === 0 ? "sem consumo" : "—";
}

function lastSale(r: IntelProductRow) {
  if (r.lastSale)
    return (
      <>
        <span className="block">{shortDate(r.lastSale)}</span>
        <span className="block text-xs text-muted-foreground">
          há {r.daysWithoutSale === null ? "—" : integer(r.daysWithoutSale)} dia(s)
        </span>
      </>
    );
  return (
    <>
      <span className="block">Sem venda</span>
      {r.daysWithoutSale !== null && (
        <span className="block text-xs text-muted-foreground">
          em {integer(r.daysWithoutSale)} dia(s) observados
        </span>
      )}
    </>
  );
}

export function IntelTable({
  companyId,
  filters,
  onChange,
  onOpen,
  viewCost,
  canExport,
}: {
  companyId: CompanyFilter;
  filters: IntelFilters;
  onChange: (patch: Partial<IntelFilters>, opts?: { replace?: boolean }) => void;
  onOpen: (row: IntelProductRow) => void;
  viewCost: boolean;
  canExport: boolean;
}) {
  const [search, setSearch] = useState(filters.q ?? "");
  const [busy, setBusy] = useState(false);
  // Última busca que esta tela mandou para o endereço: só uma busca diferente vinda do endereço
  // (link, voltar do navegador) substitui o que está digitado.
  const pushed = useRef(filters.q ?? "");
  useEffect(() => {
    const incoming = filters.q ?? "";
    if (incoming !== pushed.current) {
      pushed.current = incoming;
      setSearch(incoming);
    }
  }, [filters.q]);
  // A busca só vai para o endereço (e para o servidor) 300 ms depois da última tecla.
  useEffect(() => {
    const value = search.trim();
    if (value === pushed.current) return;
    const t = setTimeout(() => {
      pushed.current = value;
      onChange({ q: value || undefined, page: undefined }, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [search, onChange]);

  const query = toQuery(companyId, filters);
  const q = useQuery({
    queryKey: ["stock", "intel", "products", query],
    queryFn: () => intelApi.products(query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = q.data;
  const page = query.page;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const showCompany = companyId === "all";
  const set = (patch: Partial<IntelFilters>) => onChange({ ...patch, page: undefined });

  async function exportCsv() {
    setBusy(true);
    try {
      const { page: _page, ...rest } = query;
      const r = await intelApi.exportCsv(rest);
      downloadCsv(r.fileName, r.csv);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="intel-produtos" className="min-w-0 scroll-mt-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Produtos analisados</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ordenados pela prioridade para liberar capital (capital do produto, tempo sem venda,
            cobertura e queda da demanda). Clique no produto para ver os números que explicam o
            estado.
          </p>
        </div>
        {canExport && (
          <Button variant="outline" className="min-h-11" disabled={busy} onClick={exportCsv}>
            <Download aria-hidden />
            Exportar CSV
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <label className="min-w-0 space-y-1.5 sm:col-span-2 lg:col-span-1 xl:col-span-2">
          <span className="block text-xs font-medium text-muted-foreground">Buscar</span>
          <Input
            value={search}
            maxLength={120}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="SKU ou nome do produto"
            className="h-11 bg-card"
          />
        </label>
        <Choice
          label="Estado"
          value={filters.state ?? ALL}
          onChange={(v) => set({ state: v === ALL ? undefined : (v as IntelState) })}
          options={[
            { value: ALL, label: "Todos" },
            ...STATE_ORDER.map((s) => ({ value: s, label: STATE_LABELS[s] })),
          ]}
        />
        <Choice
          label="Curva (12 meses)"
          value={filters.curve ?? ALL}
          onChange={(v) => set({ curve: v === ALL ? undefined : (v as ClassifiedCurve) })}
          options={[
            { value: ALL, label: "Todas" },
            ...(["A", "B", "C", "D"] as const).map((c) => ({ value: c, label: `Curva ${c}` })),
          ]}
        />
        <Choice
          label="Faixa sem venda"
          value={filters.band ?? ALL}
          onChange={(v) => set({ band: v === ALL ? undefined : (v as IntelBand) })}
          options={[
            { value: ALL, label: "Todas" },
            ...BAND_ORDER.map((b) => ({ value: b, label: BAND_LABELS[b] })),
          ]}
        />
        <Choice
          label="Tempo sem venda"
          value={filters.minIdle ? String(filters.minIdle) : ALL}
          onChange={(v) => set({ minIdle: v === ALL ? undefined : (Number(v) as IntelMinIdle) })}
          options={[
            { value: ALL, label: "Qualquer" },
            ...MIN_IDLE.map((n) => ({ value: String(n), label: minIdleLabel(n) })),
          ]}
        />
        <Choice
          label="Sinal"
          value={filters.flag ?? ALL}
          onChange={(v) => set({ flag: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: "Todos" },
            ...Object.entries(FLAG_LABELS)
              .filter(([value]) => viewCost || !COST_FLAGS.includes(value))
              .map(([value, label]) => ({ value, label })),
          ]}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Choice
            label="Ordenar por"
            value={query.sortBy ?? "priority"}
            onChange={(v) => set({ sort: v as IntelSort })}
            options={[
              { value: "priority", label: "Prioridade" },
              ...(viewCost ? [{ value: "capital", label: "Capital" }] : []),
              { value: "daysWithoutSale", label: "Dias sem venda" },
              { value: "coverageDays", label: "Cobertura" },
              { value: "name", label: "Nome" },
            ]}
          />
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => set({ dir: query.sortDir === "desc" ? "asc" : "desc" })}
          aria-label={
            query.sortDir === "desc"
              ? "Ordem decrescente; mudar para crescente"
              : "Ordem crescente; mudar para decrescente"
          }
        >
          {query.sortDir === "desc" ? (
            <ArrowDownWideNarrow aria-hidden />
          ) : (
            <ArrowUpNarrowWide aria-hidden />
          )}
          {query.sortDir === "desc" ? "Maior primeiro" : "Menor primeiro"}
        </Button>
        {hasFilters(filters) && (
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              pushed.current = "";
              setSearch("");
              onChange({
                state: undefined,
                flag: undefined,
                curve: undefined,
                band: undefined,
                minIdle: undefined,
                q: undefined,
                page: undefined,
              });
            }}
          >
            <X aria-hidden />
            Limpar filtros
          </Button>
        )}
      </div>
      <Status loading={q.isPending} error={q.error} retry={() => q.refetch()} />
      {data && (
        <div
          className={`panel overflow-hidden transition-opacity ${q.isPlaceholderData ? "opacity-60" : ""}`}
          aria-busy={q.isFetching}
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>Estado e sinais</TableHead>
                  <TableHead className="whitespace-nowrap">Curva 12 m</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                  {viewCost && <TableHead className="text-right">Capital</TableHead>}
                  <TableHead>Última venda</TableHead>
                  <TableHead className="text-right">Cobertura</TableHead>
                  <TableHead className="text-right">Giro/ano</TableHead>
                  <TableHead className="whitespace-nowrap text-right">Tendência 60 d</TableHead>
                  <TableHead className="text-right">Prioridade</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={`${r.companyId}:${r.omieProductId}`}>
                    <TableCell className="min-w-60 max-w-80 whitespace-normal">
                      <button
                        type="button"
                        onClick={() => onOpen(r)}
                        className="text-left font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                      >
                        {r.name ?? r.sku ?? r.omieProductId}
                      </button>
                      <p className="text-xs text-muted-foreground">
                        {[r.sku, r.family, showCompany ? r.companyName : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </TableCell>
                    <TableCell className="min-w-52 space-y-1.5 whitespace-normal">
                      <StateBadge state={r.state} />
                      <FlagList flags={r.flags} max={2} />
                    </TableCell>
                    <TableCell>
                      {r.curve ? <CurveBadge curve={r.curve} /> : "—"}
                      {(r.curveSource === "manual" || r.curveWorsened) && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {[
                            r.curveSource === "manual" ? "manual" : null,
                            r.curveWorsened ? "piorou" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.qty === null ? "—" : quantity(r.qty)}
                      {r.available !== null && r.qty !== null && r.available !== r.qty && (
                        <p className="text-xs text-muted-foreground">
                          disp. {quantity(r.available)}
                        </p>
                      )}
                    </TableCell>
                    {viewCost && (
                      <TableCell className="text-right tabular-nums">
                        {r.capital !== null
                          ? money(r.capital)
                          : (r.qty ?? 0) > 0
                            ? "sem custo"
                            : "—"}
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap">{lastSale(r)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {coverage(r)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.turnoverAnnual === null
                        ? "—"
                        : r.turnoverAnnual.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {trendText(r.trend60Pct)}
                    </TableCell>
                    <TableCell className="text-right">
                      <PriorityMeter value={r.priority} />
                    </TableCell>
                  </TableRow>
                ))}
                {data.total === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="py-10 text-center">
                      Nenhum produto para estes filtros.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm">
            <p aria-live="polite">
              {integer(data.total)} {data.total === 1 ? "produto" : "produtos"} · página {page + 1}{" "}
              de {pages}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label="Página anterior"
                disabled={page === 0}
                onClick={() => onChange({ page: page - 1 === 0 ? undefined : page - 1 })}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label="Próxima página"
                disabled={(page + 1) * PAGE >= data.total}
                onClick={() => onChange({ page: page + 1 })}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
