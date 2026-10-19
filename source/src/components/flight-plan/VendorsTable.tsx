import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatValue } from "@/domain/format";
import { STATUS_META, type FlightStatus } from "@/domain/flight-plan/config";
import type { VendorRow } from "@/lib/repositories/flight-plan.repository.server";
import { StatusBadge } from "./parts";
import { cn } from "@/lib/utils";

type SortKey =
  | "name"
  | "realized"
  | "target"
  | "attainment"
  | "idealToday"
  | "deviation"
  | "remainingGap"
  | "currentDailyPace"
  | "requiredDailyPace"
  | "forecastProbable"
  | "portfolio"
  | "gapCoverage"
  | "status";

const STATUS_ORDER: Record<string, number> = { CRITICAL: 0, RISK: 1, ATTENTION: 2, ON_TRACK: 3 };

const COLS: { key: SortKey; label: string; fmt?: "currency" | "percent" }[] = [
  { key: "realized", label: "Realizado", fmt: "currency" },
  { key: "target", label: "Meta", fmt: "currency" },
  { key: "attainment", label: "%", fmt: "percent" },
  { key: "idealToday", label: "Ideal hoje", fmt: "currency" },
  { key: "deviation", label: "Desvio", fmt: "currency" },
  { key: "remainingGap", label: "Gap", fmt: "currency" },
  { key: "currentDailyPace", label: "Ritmo atual", fmt: "currency" },
  { key: "requiredDailyPace", label: "Ritmo nec.", fmt: "currency" },
  { key: "forecastProbable", label: "Forecast", fmt: "currency" },
  { key: "portfolio", label: "Carteira", fmt: "currency" },
  { key: "gapCoverage", label: "Cobertura", fmt: "percent" },
];

function actionHint(v: VendorRow): string {
  const m = v.metrics;
  if (!m.status) return "—";
  if (m.status === "ON_TRACK") return "Manter ritmo";
  if (m.gapCoverage != null && m.gapCoverage < 0.5) return "Gerar oportunidades";
  if (m.gapCoverage != null && m.gapCoverage < 1) return "Converter carteira + prospectar";
  return "Converter carteira";
}

export function VendorsTable({
  vendors,
  onSelect,
  search,
  status,
  onSearch,
  onStatus,
}: {
  vendors: VendorRow[];
  onSelect: (id: string) => void;
  search: string;
  status: FlightStatus | "ALL";
  onSearch: (v: string) => void;
  onStatus: (v: FlightStatus | "ALL") => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "status", dir: 1 });

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const val = (v: VendorRow, k: SortKey): number | string => {
      if (k === "name") return v.name;
      if (k === "status") return v.metrics.status ? STATUS_ORDER[v.metrics.status]! : 9;
      const x = v.metrics[k as keyof typeof v.metrics];
      return typeof x === "number" ? x : -Infinity;
    };
    return vendors
      .filter(
        (v) =>
          (!term || v.name.toLowerCase().includes(term)) &&
          (status === "ALL" || v.metrics.status === status),
      )
      .sort((a, b) => {
        const x = val(a, sort.key),
          y = val(b, sort.key);
        return (
          (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)) *
          sort.dir
        );
      });
  }, [vendors, search, status, sort]);

  const toggle = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: (s.dir * -1) as 1 | -1 }
        : { key, dir: key === "name" || key === "status" ? 1 : -1 },
    );
  const Head = ({ k, label, right = true }: { k: SortKey; label: string; right?: boolean }) => (
    <TableHead
      className={cn(right && "text-right")}
      aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => toggle(k)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          right && "flex-row-reverse",
        )}
      >
        {label}
        {sort.key === k &&
          (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 md:px-5">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Buscar vendedor"
            className="h-8 pl-8 text-sm"
            aria-label="Buscar vendedor"
          />
        </div>
        <Select value={status} onValueChange={(v) => onStatus(v as FlightStatus | "ALL")}>
          <SelectTrigger className="h-8 w-44 text-sm" aria-label="Filtrar status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos os status</SelectItem>
            {(Object.keys(STATUS_META) as FlightStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_META[s].symbol} {STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} de {vendors.length} vendedores
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          Nenhum vendedor para os filtros atuais.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <Head k="name" label="Vendedor" right={false} />
                {COLS.map((c) => (
                  <Head key={c.key} k={c.key} label={c.label} />
                ))}
                <Head k="status" label="Status" right={false} />
                <TableHead>Ação</TableHead>
                <TableHead className="w-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((v) => (
                <TableRow
                  key={v.id}
                  className="cursor-pointer"
                  onClick={() => onSelect(v.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && onSelect(v.id)}
                >
                  <TableCell className="font-medium whitespace-nowrap">{v.name}</TableCell>
                  {COLS.map((c) => {
                    const raw =
                      c.key === "target"
                        ? v.metrics.target
                        : (v.metrics[c.key as keyof typeof v.metrics] as number | null);
                    return (
                      <TableCell
                        key={c.key}
                        className={cn(
                          "text-right tabular whitespace-nowrap",
                          c.key === "deviation" &&
                            raw != null &&
                            (raw >= 0 ? "text-success" : "text-destructive"),
                        )}
                      >
                        {c.key === "deviation" && raw != null && raw >= 0 ? "+" : ""}
                        {formatValue(raw, c.fmt ?? "currency")}
                      </TableCell>
                    );
                  })}
                  <TableCell>
                    <StatusBadge status={v.metrics.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {actionHint(v)}
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
