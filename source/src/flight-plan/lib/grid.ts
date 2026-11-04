/** Helpers puros da grade de metas (colar do Excel e validar célula). */
export type ParsedMoney = { ok: true; value: number | null } | { ok: false; error: string };

export function parseMoneyInput(raw: string): ParsedMoney {
  const s = raw
    .trim()
    .replace(/^R\$\s*/i, "")
    .replace(/\s/g, "");
  if (!s) return { ok: true, value: null };
  if (s.startsWith("-")) return { ok: false, error: "Valor negativo não é aceito" };
  let normalized: string;
  if (s.includes(",")) normalized = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) normalized = s.replace(/\./g, "");
  else normalized = s;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { ok: false, error: "Valor inválido" };
  const dec = normalized.split(".")[1];
  if (dec && dec.length > 2) return { ok: false, error: "Use no máximo 2 casas decimais" };
  return { ok: true, value: Number(normalized) };
}

export function parsePastedBlock(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.split("\t"));
}

export const formatInputMoney = (v: number | null) =>
  v === null
    ? ""
    : v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
