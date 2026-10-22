export const money = (v: number | null) =>
  v === null
    ? "Acesso restrito"
    : v.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
export const quantity = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
export const dateTime = (v: string | null) =>
  v
    ? new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(v))
    : "Nunca lido";
export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-−@]/u.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export const csv = (rows: unknown[][]) =>
  "\uFEFF" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
export const decimal = (v: number) =>
  v.toLocaleString("pt-BR", {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export function downloadCsv(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const errorMessage = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : "Não foi possível carregar o estoque.";
