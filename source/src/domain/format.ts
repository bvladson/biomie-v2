// Brazilian formatting helpers — the single place numbers/dates become strings.
const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});
const brlCompact = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});
const int = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export type ValueFormat = "currency" | "currency_compact" | "integer" | "percent" | "days";

export function formatValue(value: number | null | undefined, format: ValueFormat): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) return "—";
  switch (format) {
    case "currency":
      return brl.format(value);
    case "currency_compact":
      return brlCompact.format(value);
    case "integer":
      return int.format(value);
    case "percent":
      return pct.format(value);
    case "days":
      return `${int.format(value)} ${value === 1 ? "dia" : "dias"}`;
  }
}

export function formatDelta(delta: number | null): string {
  if (delta == null || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${pct.format(delta)}`;
}

const MONTHS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} / ${year}`;
}

export function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** Masks CPF (11 digits) / CNPJ (14 digits) for display (LGPD). */
export function maskDocument(doc: string | null | undefined): string {
  // The server already returns masked values (public.customer_document); keep them as-is.
  if (doc && doc.includes("*")) return doc;
  const d = (doc ?? "").replace(/\D/g, "");
  if (d.length === 14) return `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-**`;
  if (d.length === 11) return `***.${d.slice(3, 6)}.***-**`;
  return "—";
}
