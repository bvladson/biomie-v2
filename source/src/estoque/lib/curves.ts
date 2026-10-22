/**
 * Curva automática (migração 0043): rótulos e textos usados pelas telas e pelo CSV.
 * A regra fica no banco; aqui só se explica o que ele devolve.
 */
import type { AgingBand, CurveWindow, IncompleteReason, StockPosition } from "../api/contract";

export const CURVE_WINDOWS: CurveWindow[] = ["30d", "90d", "180d", "12m"];
export const DEFAULT_WINDOW: CurveWindow = "12m";
export const WINDOW_LABELS: Record<CurveWindow, string> = {
  "30d": "30 dias",
  "90d": "90 dias",
  "180d": "180 dias",
  "12m": "12 meses",
};
export const isCurveWindow = (v: unknown): v is CurveWindow =>
  typeof v === "string" && (CURVE_WINDOWS as string[]).includes(v);

/** Faixas de tempo sem venda (independentes da janela), como aprovado. */
export const AGING_BANDS: {
  band: AgingBand;
  days: 30 | 90 | 180 | 365;
  label: string;
  range: string;
}[] = [
  { band: "30", days: 30, label: "Sem venda recente", range: "30 a 89 dias" },
  { band: "90", days: 90, label: "Atenção ao giro", range: "90 a 179 dias" },
  { band: "180", days: 180, label: "Possível estoque parado", range: "180 a 364 dias" },
  { band: "365", days: 365, label: "Estoque sem vendas prolongado", range: "365 dias ou mais" },
];

/** Entradas do ListarMovimentoEstoque (origens reais do Omie, 22/10/2026). */
const ENTRIES: Record<string, string> = {
  "00": "Ajuste manual",
  "13": "Devolução de venda",
  "21": "Compra",
  "22": "Importação",
  "24": "Retorno / nota de entrada",
  "28": "Entrada da produção",
};
/** Saídas que mostram giro (as demais são estornos ou notas complementares). */
const EXITS: Record<string, string> = {
  "00": "Ajuste manual",
  "11": "Venda",
  "12": "Venda pelo PDV",
  "14": "Remessa",
  "23": "Devolução ao fornecedor",
  "28": "Consumo na produção",
};
export const operationLabel = (code: string | null | undefined) =>
  code ? (ENTRIES[code] ?? `Operação ${code}`) : "";
export const exitLabel = (code: string | null | undefined) =>
  code ? (EXITS[code] ?? `Operação ${code}`) : "";

/** Data "AAAA-MM-DD" do banco como "DD/MM/AAAA" (sem fuso: é uma data, não um instante). */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}

export function incompleteLabel(reason: IncompleteReason | null | undefined, p?: StockPosition) {
  if (reason === "sales")
    return p?.salesFrom
      ? `Histórico incompleto: vendas no BIOMIE desde ${shortDate(p.salesFrom)}`
      : "Histórico incompleto: vendas da janela não disponíveis";
  if (reason === "product")
    return p?.arrivedOn
      ? `Histórico incompleto: produto chegou em ${shortDate(p.arrivedOn)}`
      : "Histórico incompleto: produto mais novo que a janela";
  return "";
}

/**
 * Texto da última venda: data e dias; quem nunca vendeu no histórico mostra desde quando — a
 * chegada do produto, se veio depois do início do histórico, ou o próprio início do histórico.
 */
export function lastSaleText(p: StockPosition): string {
  const days = p.daysWithoutSale;
  const ago = days === null || days === undefined ? "" : ` · ${days} dia${days === 1 ? "" : "s"}`;
  if (p.lastSale) return `${shortDate(p.lastSale)}${ago.replace(" · ", " · há ")}`;
  const since = p.idleSince ?? p.salesFrom;
  if (!since) return "Sem venda no histórico";
  return since === p.arrivedOn && p.salesFrom && since > p.salesFrom
    ? `Sem venda desde a chegada (${shortDate(since)})${ago}`
    : `Sem venda desde ${shortDate(since)} (início do histórico)${ago}`;
}

export const percent = (share: number | null | undefined) =>
  share === null || share === undefined
    ? "—"
    : `${(share * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
