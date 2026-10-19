import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportCsv, exportXlsx, type ExportColumn } from "@/lib/export";

export function ExportMenu<T>({
  rows,
  columns,
  name,
}: {
  rows: T[];
  columns: ExportColumn<T>[];
  name: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={!rows.length}>
          <Download className="size-3.5" /> Exportar
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => exportCsv(rows, columns, name)}>CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void exportXlsx(rows, columns, name)}>
          Excel (XLSX)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
