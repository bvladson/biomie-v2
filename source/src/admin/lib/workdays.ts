import type { Holiday } from "../api/contract";

export const MONTHS = [
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

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Dias úteis (segunda a sexta menos feriados) de um mês.
 * `remaining` conta a partir de `today` (inclusive); meses passados = 0.
 */
export function monthWorkdays(
  year: number,
  month: number,
  holidays: Pick<Holiday, "date">[],
  today: string,
) {
  const off = new Set(holidays.map((h) => h.date));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let total = 0;
  let remaining = 0;
  for (let d = 1; d <= days; d++) {
    const wd = new Date(Date.UTC(year, month, d)).getUTCDay();
    const date = iso(year, month, d);
    if (wd === 0 || wd === 6 || off.has(date)) continue;
    total++;
    if (date >= today) remaining++;
  }
  return { total, remaining };
}

export interface ParsedHolidayLine {
  line: number;
  raw: string;
  date?: string;
  name?: string;
  error?: string;
  duplicate?: boolean;
}

/** Interpreta "DD/MM/AAAA;Nome" por linha e marca duplicados (na lista ou já existentes). */
export function parseHolidayList(text: string, existingDates: string[]): ParsedHolidayLine[] {
  const seen = new Set(existingDates);
  return text
    .split(/\r?\n/)
    .map((raw, i) => ({ raw: raw.trim(), line: i + 1 }))
    .filter((l) => l.raw)
    .map(({ raw, line }) => {
      const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s*;\s*(.+)$/);
      if (!m) return { line, raw, error: "Formato inválido (use DD/MM/AAAA;Nome)" };
      const [, dd = "", mm = "", yyyy = "", name = ""] = m;
      const dt = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
      if (dt.getUTCMonth() !== +mm - 1 || dt.getUTCDate() !== +dd)
        return { line, raw, error: "Data inexistente" };
      const date = `${yyyy}-${mm}-${dd}`;
      const duplicate = seen.has(date);
      seen.add(date);
      return { line, raw, date, name: name.trim(), duplicate };
    });
}
