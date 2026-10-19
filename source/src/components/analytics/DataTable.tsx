import { useMemo, useState } from "react";
import { ArrowDownUp, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  sort?: (row: T) => number | string | null;
  align?: "right" | "left";
  className?: string;
}

/** Generic sortable/searchable/paged table used by every listing. */
export function DataTable<T>({
  rows,
  columns,
  search,
  rowKey,
  onRowClick,
  toolbar,
  pageSize = 100,
  empty = "Nenhum registro para os filtros aplicados.",
  initialSort,
}: {
  rows: T[];
  columns: Column<T>[];
  search?: (row: T) => string;
  rowKey: (row: T, i: number) => string;
  onRowClick?: (row: T) => void;
  toolbar?: React.ReactNode;
  pageSize?: number;
  empty?: string;
  initialSort?: { key: string; dir: "asc" | "desc" };
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(initialSort ?? null);
  const [limit, setLimit] = useState(pageSize);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out =
      needle && search ? rows.filter((r) => search(r).toLowerCase().includes(needle)) : rows;
    const col = sort && columns.find((c) => c.key === sort.key);
    if (col?.sort) {
      const f = col.sort;
      out = [...out].sort((a, b) => {
        const va = f(a) ?? -Infinity;
        const vb = f(b) ?? -Infinity;
        const r = va < vb ? -1 : va > vb ? 1 : 0;
        return sort!.dir === "asc" ? r : -r;
      });
    }
    return out;
  }, [rows, q, sort, columns, search]);

  return (
    <div className="flex flex-col">
      {(search || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          {search && (
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar…"
                className="h-8 pl-8"
                aria-label="Buscar na tabela"
              />
            </div>
          )}
          <span className="text-xs text-muted-foreground tabular">
            {filtered.length.toLocaleString("pt-BR")} registros
          </span>
          <div className="ml-auto flex items-center gap-2">{toolbar}</div>
        </div>
      )}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn("whitespace-nowrap text-xs", c.align === "right" && "text-right")}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() =>
                        setSort((s) =>
                          s?.key === c.key
                            ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" }
                            : { key: c.key, dir: "desc" },
                        )
                      }
                    >
                      {c.header}
                      <ArrowDownUp
                        className={cn("size-3", sort?.key === c.key ? "opacity-100" : "opacity-30")}
                      />
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.slice(0, limit).map((r, i) => (
              <TableRow
                key={rowKey(r, i)}
                className={cn(onRowClick && "cursor-pointer")}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => e.key === "Enter" && onRowClick(r) : undefined}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={cn(
                      "whitespace-nowrap text-sm",
                      c.align === "right" && "text-right tabular",
                      c.className,
                    )}
                  >
                    {c.cell(r)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!filtered.length && (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {filtered.length > limit && (
        <div className="border-t p-3 text-center">
          <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + pageSize * 5)}>
            Mostrar mais ({(filtered.length - limit).toLocaleString("pt-BR")} restantes)
          </Button>
        </div>
      )}
    </div>
  );
}
