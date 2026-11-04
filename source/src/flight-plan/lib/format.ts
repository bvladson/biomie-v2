const nbsp = /\u00a0/g;
export const brl = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(nbsp, " ");
export const brl0 = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : v
        .toLocaleString("pt-BR", {
          style: "currency",
          currency: "BRL",
          maximumFractionDigits: 0,
          minimumFractionDigits: 0,
        })
        .replace(nbsp, " ");
export const pct = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) +
      "%";
export const pct0 = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : (v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + "%";
export const num = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("pt-BR", { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const dateBr = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
export const dayMonth = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);
export const dateTimeBr = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
export const monthLabel = (month: string) =>
  `${MONTHS[Number(month.slice(5)) - 1]} de ${month.slice(0, 4)}`;
export const monthShort = (month: string) => MONTHS[Number(month.slice(5)) - 1]!.slice(0, 3);

export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-@]/u.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export const toCsv = (rows: unknown[][]) =>
  "\uFEFF" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
export const decimalCsv = (v: number | null) =>
  v === null ? "" : v.toLocaleString("pt-BR", { useGrouping: false, maximumFractionDigits: 2 });
export function downloadCsv(name: string, rows: unknown[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
