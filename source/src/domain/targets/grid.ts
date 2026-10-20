import type { TargetLevel } from "@/domain/flight-plan/config";

/** Column order of the grid (and of a block pasted from a spreadsheet). */
export const TARGET_LEVELS: TargetLevel[] = ["BASE", "ACTIVE", "CHALLENGE"];
export const MAX_TARGET = 999_999_999_999.99;

export interface GridSeller {
  id: string;
  name: string;
  team: string | null;
  active: boolean;
  editable: boolean;
  targets: Partial<Record<TargetLevel, number>>;
  previous: Partial<Record<TargetLevel, number>>;
}

/** What the user typed in each cell, keyed by cellKey(seller, level). */
export type Draft = Record<string, string>;

export interface TargetChange {
  seller: string;
  level: TargetLevel;
  /** null clears the stored value. */
  amount: number | null;
}

export interface CellError {
  key: string;
  message: string;
}

export const cellKey = (seller: string, level: TargetLevel) => `${seller}:${level}`;

const brl = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** How a stored amount appears in its cell ("350.000,00"); empty when there is none. */
export function formatAmount(value: number | null | undefined): string {
  return value == null ? "" : brl.format(value);
}

/**
 * Reads an amount typed or pasted in the formats people use in Brazil:
 * "350.000,00", "R$ 350.000", "350000", "350000,5", "350000.50", "1.234.567".
 * Empty text means "no target" (null); anything else unreadable is NaN.
 */
export function parseAmount(text: string): number | null {
  const raw = text.replace(/R\$|\s/g, "");
  if (!raw) return null;
  if (!/^-?[\d.,]+$/.test(raw) || !/\d/.test(raw)) return Number.NaN;
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  let normalized: string;
  if (lastComma > -1 && lastDot > -1) {
    // Both present: the last one is the decimal separator.
    normalized =
      lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (lastComma > -1) {
    normalized = raw.split(",").length > 2 ? raw.replace(/,/g, "") : raw.replace(",", ".");
  } else if (lastDot > -1) {
    // "350.000" and "1.234.567" are thousands in pt-BR; "350000.50" is a decimal point.
    const parts = raw.split(".");
    const thousands = parts.length > 2 || parts[1]!.length === 3;
    normalized = thousands ? raw.replace(/\./g, "") : raw;
  } else normalized = raw;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : Number.NaN;
}

/** The draft that shows exactly what is stored. */
export function initialDraft(sellers: GridSeller[]): Draft {
  const draft: Draft = {};
  for (const seller of sellers)
    for (const level of TARGET_LEVELS)
      draft[cellKey(seller.id, level)] = formatAmount(seller.targets[level]);
  return draft;
}

/** Splits text copied from a spreadsheet (tab-separated cells, one line per row). */
export function parseClipboard(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return normalized === "" ? [] : normalized.split("\n").map((line) => line.split("\t"));
}

/**
 * Pastes a block starting at a row and a level column, the way a spreadsheet does.
 * Read-only rows and cells beyond the three levels are skipped and counted.
 */
export function applyPaste(
  sellers: GridSeller[],
  draft: Draft,
  startRow: number,
  startColumn: number,
  block: string[][],
): { draft: Draft; applied: number; skipped: number } {
  const next = { ...draft };
  let applied = 0;
  let skipped = 0;
  block.forEach((cells, i) => {
    const seller = sellers[startRow + i];
    cells.forEach((cell, j) => {
      const level = TARGET_LEVELS[startColumn + j];
      if (!seller || !level || !seller.editable) {
        skipped++;
        return;
      }
      next[cellKey(seller.id, level)] = cell.trim();
      applied++;
    });
  });
  return { draft: next, applied, skipped };
}

/** Fills empty editable cells with last month's value. */
export function copyPrevious(
  sellers: GridSeller[],
  draft: Draft,
): { draft: Draft; filled: number } {
  const next = { ...draft };
  let filled = 0;
  for (const seller of sellers) {
    if (!seller.editable) continue;
    for (const level of TARGET_LEVELS) {
      const key = cellKey(seller.id, level);
      const previous = seller.previous[level];
      if (previous == null || (next[key] ?? "").trim() !== "") continue;
      next[key] = formatAmount(previous);
      filled++;
    }
  }
  return { draft: next, filled };
}

/** Compares the draft with what is stored; invalid cells are reported and never sent. */
export function buildChanges(
  sellers: GridSeller[],
  draft: Draft,
): { changes: TargetChange[]; errors: CellError[] } {
  const changes: TargetChange[] = [];
  const errors: CellError[] = [];
  for (const seller of sellers) {
    if (!seller.editable) continue;
    for (const level of TARGET_LEVELS) {
      const key = cellKey(seller.id, level);
      if (!(key in draft)) continue;
      const amount = parseAmount(draft[key]!);
      if (amount !== null && Number.isNaN(amount)) {
        errors.push({ key, message: "Valor inválido" });
        continue;
      }
      if (amount !== null && amount < 0) {
        errors.push({ key, message: "Meta não pode ser negativa" });
        continue;
      }
      if (amount !== null && amount > MAX_TARGET) {
        errors.push({ key, message: "Valor grande demais" });
        continue;
      }
      const stored = seller.targets[level] ?? null;
      const same =
        amount === stored ||
        (amount !== null && stored !== null && Math.abs(amount - stored) < 0.005);
      if (!same) changes.push({ seller: seller.id, level, amount });
    }
  }
  return { changes, errors };
}

/** The value a cell currently shows: the valid draft value, or null. */
export function cellValue(draft: Draft, seller: string, level: TargetLevel): number | null {
  const amount = parseAmount(draft[cellKey(seller, level)] ?? "");
  return amount === null || Number.isNaN(amount) ? null : amount;
}

/** Levels out of order for one seller (Base ≤ Ativa ≤ Desafio); a warning, not an error. */
export function levelWarnings(draft: Draft, seller: string): string[] {
  const base = cellValue(draft, seller, "BASE");
  const active = cellValue(draft, seller, "ACTIVE");
  const challenge = cellValue(draft, seller, "CHALLENGE");
  const warnings: string[] = [];
  if (base !== null && active !== null && base > active) warnings.push("Base acima da Ativa");
  if (active !== null && challenge !== null && active > challenge)
    warnings.push("Ativa acima do Desafio");
  return warnings;
}

/** Column totals of what the grid currently shows. */
export function totals(sellers: GridSeller[], draft: Draft): Record<TargetLevel, number> {
  const sum: Record<TargetLevel, number> = { BASE: 0, ACTIVE: 0, CHALLENGE: 0 };
  for (const seller of sellers)
    for (const level of TARGET_LEVELS) sum[level] += cellValue(draft, seller.id, level) ?? 0;
  for (const level of TARGET_LEVELS) sum[level] = Math.round(sum[level] * 100) / 100;
  return sum;
}
