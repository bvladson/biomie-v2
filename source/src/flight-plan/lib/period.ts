/** Trimestre/ano: % e ritmo comparam só os meses que têm meta. */

export { partialPeriod, type PartialPeriod, type PeriodMonth } from "@/domain/flight-plan/engine";
import type { PartialPeriod } from "@/domain/flight-plan/engine";

export const missingTargetLabel = (p: PartialPeriod) =>
  p.missingTarget === 0
    ? null
    : p.missingTarget === p.months
      ? `Sem meta: nenhum dos ${p.months} meses tem meta`
      : `Meta incompleta: ${p.missingTarget} de ${p.months} meses sem meta`;

/** Peso do sábado da empresa em texto: 0,33 → " (sábado conta 1/3)"; 0 ou 1 → "". */
export function saturdayNote(saturdayWeight: number) {
  if (!(saturdayWeight > 0 && saturdayWeight < 1)) return "";
  const known: [number, string][] = [
    [1 / 3, "1/3"],
    [1 / 2, "1/2"],
    [1 / 4, "1/4"],
    [2 / 3, "2/3"],
  ];
  const hit = known.find(([v]) => Math.abs(v - saturdayWeight) < 0.01);
  const txt = hit ? hit[1] : saturdayWeight.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return ` (sábado conta ${txt})`;
}

/** Dia útil fracionado: "7,66 dias úteis (sábado conta 1/3)", com o peso do sábado da empresa. */
export function workdaysLabel(v: number, saturdayWeight: number, suffix = "") {
  const txt = v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const word = v === 1 ? "dia útil" : "dias úteis";
  const frac = Math.abs(v - Math.round(v)) > 1e-9 ? saturdayNote(saturdayWeight) : "";
  return `${txt} ${word}${suffix ? " " + suffix : ""}${frac}`;
}

export const quarterOf = (month: string) => {
  const y = month.slice(0, 4),
    q = Math.floor((Number(month.slice(5)) - 1) / 3);
  return [1, 2, 3].map((i) => `${y}-${String(q * 3 + i).padStart(2, "0")}`);
};
export const yearOf = (month: string) =>
  Array.from({ length: 12 }, (_, i) => `${month.slice(0, 4)}-${String(i + 1).padStart(2, "0")}`);
