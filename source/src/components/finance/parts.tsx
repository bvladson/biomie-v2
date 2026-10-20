import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Download } from "lucide-react";
import { toast } from "sonner";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataTable, type Column } from "@/components/analytics/DataTable";
import { fmtDate, keepSearch } from "@/components/entities/shared";
import { formatValue } from "@/domain/format";
import { share } from "@/domain/metrics/compute";
import {
  AGING_LABELS,
  TITLE_STATUS_LABELS,
  type AgingRow,
  type TitleStatus,
} from "@/domain/finance";
import { exportCsv, exportXlsx, type ExportColumn } from "@/lib/export";
import { authorizeFinanceExport } from "@/lib/finance.functions";
import type { TitleRow } from "@/lib/repositories/finance.repository.server";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<TitleStatus, string> = {
  OPEN: "border-border text-foreground",
  PARTIALLY_PAID: "border-warning/40 text-warning",
  PAID: "border-success/40 text-success",
  OVERDUE: "border-destructive/40 text-destructive",
  CANCELLED: "border-border text-muted-foreground line-through",
};

export function StatusBadge({ status }: { status: TitleStatus }) {
  return (
    <Badge variant="outline" className={cn("font-normal", STATUS_CLASS[status])}>
      {TITLE_STATUS_LABELS[status]}
    </Badge>
  );
}

export function AgingTable({
  rows,
  overdueVisible,
}: {
  rows: AgingRow[];
  overdueVisible: boolean;
}) {
  const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-medium">Faixa</th>
            <th className="px-4 py-2 text-right font-medium">Valor</th>
            <th className="px-4 py-2 text-right font-medium">%</th>
            <th className="px-4 py-2 text-right font-medium">Títulos</th>
            <th className="px-4 py-2 text-right font-medium">Clientes</th>
            <th className="w-1/3 px-4 py-2" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = r.value == null ? null : share(r.value, total);
            return (
              <tr key={r.bucket} className="border-b last:border-0">
                <td className="px-4 py-2">{AGING_LABELS[r.bucket]}</td>
                <td className="px-4 py-2 text-right tabular">{formatValue(r.value, "currency")}</td>
                <td className="px-4 py-2 text-right tabular">{formatValue(pct, "percent")}</td>
                <td className="px-4 py-2 text-right tabular">{formatValue(r.titles, "integer")}</td>
                <td className="px-4 py-2 text-right tabular">
                  {formatValue(r.customers, "integer")}
                </td>
                <td className="px-4 py-2">
                  <div className="h-2 rounded bg-muted">
                    <div
                      className={cn(
                        "h-2 rounded",
                        r.bucket === "future" ? "bg-chart-1" : "bg-destructive/70",
                      )}
                      style={{ width: `${Math.round((pct ?? 0) * 100)}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!overdueVisible && (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Faixas vencidas ocultas: seu perfil não tem a permissão de ver inadimplência.
        </p>
      )}
    </div>
  );
}

export function BilledVsReceivedChart({
  data,
}: {
  data: { month: string; billed: number; received: number }[];
}) {
  const points = data.map((d) => ({
    label: `${d.month.slice(5)}/${d.month.slice(2, 4)}`,
    Faturado: d.billed,
    Recebido: d.received,
  }));
  return (
    <div className="h-80 p-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ left: 8, right: 8, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
          <YAxis
            tick={{ fontSize: 11 }}
            stroke="var(--muted-foreground)"
            width={70}
            tickFormatter={(v: number) => formatValue(v, "currency_compact")}
          />
          <Tooltip
            formatter={(v: number) => formatValue(v, "currency")}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Faturado" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
          <Bar dataKey="Recebido" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Export menu gated + audited server-side (finance.export). */
export function FinanceExportMenu<T>({
  company,
  kind,
  rows,
  columns,
  name,
  allowed,
}: {
  company: string;
  kind: string;
  rows: T[];
  columns: ExportColumn<T>[];
  name: string;
  allowed: boolean;
}) {
  const authorize = useServerFn(authorizeFinanceExport);
  if (!allowed) return null;
  const run = async (format: "csv" | "xlsx") => {
    try {
      await authorize({ data: { company, kind, rows: rows.length, format } });
      if (format === "csv") exportCsv(rows, columns, name);
      else await exportXlsx(rows, columns, name);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={!rows.length}>
          <Download className="size-3.5" /> Exportar
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void run("csv")}>CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run("xlsx")}>Excel (XLSX)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const titleExportColumns = (withCustomer: boolean): ExportColumn<TitleRow>[] => [
  ...(withCustomer ? [{ header: "Cliente", value: (r: TitleRow) => r.customer }] : []),
  { header: "Documento", value: (r) => r.document },
  { header: "Parcela", value: (r) => `${r.installment}/${r.installments}` },
  { header: "Emissão", value: (r) => r.issueDate },
  { header: "Vencimento", value: (r) => r.dueDate },
  { header: "Liquidação", value: (r) => r.settledDate },
  { header: "Valor original", value: (r) => r.original },
  { header: "Ajustes (juros+multa−desconto)", value: (r) => r.adjustments },
  { header: "Pago", value: (r) => r.paid },
  { header: "Saldo", value: (r) => r.open },
  { header: "Dias de atraso", value: (r) => r.daysLate },
  { header: "Status", value: (r) => TITLE_STATUS_LABELS[r.status] },
  { header: "Vendedor", value: (r) => r.seller },
];

export function TitlesTable({
  rows,
  withCustomer,
  overdueVisible,
  toolbar,
}: {
  rows: TitleRow[];
  withCustomer: boolean;
  overdueVisible: boolean;
  toolbar?: React.ReactNode;
}) {
  const columns: Column<TitleRow>[] = [
    ...(withCustomer
      ? [
          {
            key: "customer",
            header: "Cliente",
            cell: (r: TitleRow) =>
              r.customerId ? (
                <Link
                  to="/clientes/$customerId"
                  params={{ customerId: r.customerId }}
                  search={keepSearch}
                  className="font-medium hover:underline"
                >
                  {r.customer}
                </Link>
              ) : (
                "—"
              ),
            sort: (r: TitleRow) => r.customer ?? "",
          },
        ]
      : []),
    { key: "doc", header: "Documento", cell: (r) => r.document, sort: (r) => r.document },
    {
      key: "inst",
      header: "Parcela",
      cell: (r) => `${r.installment}/${r.installments}`,
      sort: (r) => r.installment,
    },
    {
      key: "issue",
      header: "Emissão",
      cell: (r) => fmtDate(r.issueDate),
      sort: (r) => r.issueDate,
    },
    { key: "due", header: "Vencimento", cell: (r) => fmtDate(r.dueDate), sort: (r) => r.dueDate },
    {
      key: "settled",
      header: "Liquidação",
      cell: (r) => fmtDate(r.settledDate),
      sort: (r) => r.settledDate ?? "",
    },
    {
      key: "original",
      header: "Valor original",
      align: "right",
      cell: (r) => formatValue(r.original, "currency"),
      sort: (r) => r.original,
    },
    {
      key: "paid",
      header: "Pago",
      align: "right",
      cell: (r) => formatValue(r.paid, "currency"),
      sort: (r) => r.paid,
    },
    {
      key: "open",
      header: "Saldo",
      align: "right",
      cell: (r) => formatValue(r.open, "currency"),
      sort: (r) => r.open,
    },
    ...(overdueVisible
      ? [
          {
            key: "late",
            header: "Dias de atraso",
            align: "right" as const,
            cell: (r: TitleRow) => (
              <span className={r.status === "OVERDUE" ? "text-destructive" : undefined}>
                {r.daysLate ?? "—"}
              </span>
            ),
            sort: (r: TitleRow) => r.daysLate,
          },
        ]
      : []),
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge status={r.status} />,
      sort: (r) => r.status,
    },
    {
      key: "seller",
      header: "Vendedor",
      cell: (r) => r.seller ?? "—",
      sort: (r) => r.seller ?? "",
    },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      search={(r) => `${r.customer ?? ""} ${r.document} ${r.seller ?? ""}`}
      toolbar={toolbar}
      initialSort={{ key: "due", dir: "desc" }}
    />
  );
}
