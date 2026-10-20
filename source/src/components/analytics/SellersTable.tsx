import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatValue } from "@/domain/format";
import type { CockpitDTO } from "@/lib/repositories/analytics.repository.server";
import { cn } from "@/lib/utils";

function statusOf(att: number | null, expected: number) {
  if (att == null) return { label: "Sem meta", tone: "text-muted-foreground" };
  if (att >= expected) return { label: "No ritmo", tone: "text-success" };
  if (att >= expected * 0.85) return { label: "Atenção", tone: "text-warning" };
  return { label: "Abaixo", tone: "text-destructive" };
}

export function SellersTable({
  sellers,
  expectedPace,
}: {
  sellers: CockpitDTO["sellers"];
  expectedPace: number;
}) {
  if (!sellers.length)
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        Nenhum vendedor para os filtros atuais.
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Vendedor</TableHead>
          <TableHead className="text-right">Faturamento</TableHead>
          <TableHead className="text-right">Meta</TableHead>
          <TableHead className="w-[28%]">Atingimento</TableHead>
          <TableHead className="text-right">NFs</TableHead>
          <TableHead className="text-right">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sellers.map((s) => {
          const st = statusOf(s.attainment, expectedPace);
          return (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell className="text-right tabular">
                {formatValue(s.revenue, "currency")}
              </TableCell>
              <TableCell className="text-right tabular text-muted-foreground">
                {formatValue(s.target, "currency")}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-chart-1"
                      style={{ width: `${Math.min((s.attainment ?? 0) * 100, 100)}%` }}
                    />
                    <div
                      className="absolute inset-y-0 w-px bg-foreground/40"
                      style={{ left: `${Math.min(expectedPace * 100, 100)}%` }}
                    />
                  </div>
                  <span className="w-14 text-right text-xs tabular">
                    {formatValue(s.attainment, "percent")}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right tabular">
                {formatValue(s.invoices, "integer")}
              </TableCell>
              <TableCell className={cn("text-right text-xs font-medium", st.tone)}>
                {st.label}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
