/** Regras puras da grade de metas: ordem visual, colar do Excel, Enter e "Não distribuído". */
import type { Channel, TargetLevel, TargetSet } from "../api/contract";

export const CHANNEL_ORDER: Channel[] = ["varejo", "licitacao"];

export interface GridSeller {
  id: string;
  channel: Channel | null;
  editable: boolean;
}

/** Ordem em que os vendedores aparecem na tela: Varejo, depois Licitação (ordem da API dentro do grupo). */
export function displayOrder<T extends GridSeller>(sellers: T[]): T[] {
  return CHANNEL_ORDER.flatMap((ch) => sellers.filter((s) => s.channel === ch));
}

export interface PastePlan {
  cells: { sellerId: string; level: TargetLevel; value: string }[];
  applied: number;
  ignored: number;
}

/**
 * Distribui um bloco colado a partir de (startId, startCol) seguindo a ordem da tela.
 * Não atravessa para outro grupo de canal; linhas que sobram ou caem em vendedor sem
 * permissão são ignoradas.
 */
export function planPaste(
  sellers: GridSeller[],
  startId: string,
  startCol: number,
  block: string[][],
  levels: TargetLevel[],
): PastePlan {
  const start = sellers.find((s) => s.id === startId);
  const group = start ? displayOrder(sellers).filter((s) => s.channel === start.channel) : [];
  const from = group.findIndex((s) => s.id === startId);
  const out: PastePlan = { cells: [], applied: 0, ignored: 0 };
  block.forEach((row, r) => {
    const s = from < 0 ? undefined : group[from + r];
    if (!s || !s.editable) {
      out.ignored++;
      return;
    }
    let any = false;
    row.forEach((cell, c) => {
      const level = levels[startCol + c];
      if (!level) return;
      any = true;
      out.cells.push({ sellerId: s.id, level, value: cell.trim() });
    });
    if (any) out.applied++;
    else out.ignored++;
  });
  return out;
}

/** Próximo vendedor editável na ordem da tela (Enter desce, Shift+Enter sobe). */
export function nextEditable(sellers: GridSeller[], fromId: string, dir: 1 | -1): string | null {
  const order = displayOrder(sellers);
  let i = order.findIndex((s) => s.id === fromId) + dir;
  while (i >= 0 && i < order.length) {
    if (order[i]!.editable) return order[i]!.id;
    i += dir;
  }
  return null;
}

/**
 * "Não distribuído" oficial da API (considera todos os vendedores, inclusive fora do
 * escopo), ajustado só pelas alterações ainda não salvas.
 */
export function adjustedUndistributed(
  api: TargetSet,
  level: TargetLevel,
  companyOriginal: number | null,
  companyDraft: number | null,
  sellerDelta: number,
): number | null {
  if (companyDraft === null) return null;
  const base = api[level];
  if (base === null) return null;
  return Math.round((base + (companyDraft - (companyOriginal ?? 0)) - sellerDelta) * 100) / 100;
}
