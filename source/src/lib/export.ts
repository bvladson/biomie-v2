/**
 * Table export (CSV/XLSX). Exports exactly the rows passed in — callers pass
 * the server result for the active filters, so the file matches the screen.
 */
export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

const escapeCsv = (v: string | number | null | undefined) => {
  if (v == null) return "";
  // Keep text imported from source systems from executing as spreadsheet formulas.
  const s =
    typeof v === "number"
      ? String(v).replace(".", ",")
      : /^[\s]*[=+@-]|^[\t\r\n]/.test(v)
        ? `'${v}`
        : v;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** pt-BR CSV: ';' separator, decimal comma, UTF-8 BOM (opens correctly in Excel). */
export function toCsv<T>(rows: T[], cols: ExportColumn<T>[]): string {
  const lines = [cols.map((c) => escapeCsv(c.header)).join(";")];
  for (const r of rows) lines.push(cols.map((c) => escapeCsv(c.value(r))).join(";"));
  return "\uFEFF" + lines.join("\r\n");
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCsv<T>(rows: T[], cols: ExportColumn<T>[], baseName: string) {
  download(new Blob([toCsv(rows, cols)], { type: "text/csv;charset=utf-8" }), `${baseName}.csv`);
}

export async function exportXlsx<T>(rows: T[], cols: ExportColumn<T>[], baseName: string) {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const data = [
    cols.map((c) => ({ value: c.header, fontWeight: "bold" as const })),
    ...rows.map((r) =>
      cols.map((c) => {
        const v = c.value(r);
        return v == null ? null : { value: v };
      }),
    ),
  ];
  await writeXlsxFile(data as never).toFile(`${baseName}.xlsx`);
}

/** File name that encodes the context (company/period/filters). */
export function exportName(
  kind: string,
  q: {
    period: string;
    seller?: string | undefined;
    category?: string | undefined;
    state?: string | undefined;
  },
) {
  const parts = ["biomie", kind, q.period];
  if (q.seller) parts.push("vendedor");
  if (q.category) parts.push(q.category);
  if (q.state) parts.push(q.state);
  return parts.join("_").replace(/[^\w\-.]+/g, "-");
}
