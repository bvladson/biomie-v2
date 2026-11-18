// Trava de números do assistente: todo número da resposta precisa existir nos fatos (com tolerância de
// formatação). Se algum não existir, a resposta é DESCARTADA e entra um texto-modelo com os fatos
// (recomendação da Fase 3: o modelo 0.8B inventou "10,2%" quando não sabia).

const NUMBER_RE = /-?\d[\d.,]*/g;

/**
 * Leituras possíveis de um número escrito (pt-BR ou en): "1.234,56" → 1234.56; "91,6" → 91.6;
 * "1.503" → 1503 (milhar) e 1.503 (decimal); "12" → 12. Datas são tratadas à parte.
 */
export function readingsOf(token: string): number[] {
  // Pontuação no fim ("R$ 862.350.") não pode virar NaN e passar sem conferência.
  const t = token.replace(/^-/, "").replace(/[.,]+$/, "");
  if (!/\d/.test(t)) return [];
  const out = new Set<number>();
  const hasDot = t.includes(".");
  const hasComma = t.includes(",");
  if (hasDot && hasComma) {
    // O último separador é o decimal; o outro é milhar.
    const dec = t.lastIndexOf(",") > t.lastIndexOf(".") ? "," : ".";
    const cleaned = t.replace(new RegExp(`[${dec === "," ? "." : ","}]`, "g"), "");
    out.add(Number(cleaned.replace(dec, ".")));
  } else if (hasComma) {
    out.add(Number(t.replace(/\./g, "").replace(",", ".")));
    if (/^\d{1,3}(,\d{3})+$/.test(t)) out.add(Number(t.replace(/,/g, "")));
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) out.add(Number(t.replace(/\./g, "")));
    out.add(Number(t));
  } else {
    out.add(Number(t));
  }
  return [...out].filter((n) => Number.isFinite(n));
}

/** Todos os valores numéricos citáveis de um texto (fatos ou resposta). */
export function numbersOf(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) out.push(...readingsOf(m[0]));
  return out;
}

const near = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 0.0005) ||
  // Arredondamento de exibição: 412.350,00 citado como "412 mil" não passa; 91,6 citado como 92 passa.
  (Number.isInteger(a) && Math.abs(a - b) < 0.5);

export interface VerifyResult {
  ok: boolean;
  /** Números da resposta que não estão nos fatos. */
  flagged: string[];
}

/**
 * Compara os números da resposta com os dos fatos. Tolerâncias: inteiros pequenos (0–31, contagens e
 * dias), anos 2019–2035 e horas/datas não derrubam a resposta; o resto precisa casar com algum fato.
 */
export function verifyAnswer(answer: string, factLines: string[]): VerifyResult {
  const allowed = numbersOf(factLines.join("\n"));
  const flagged: string[] = [];
  // Datas (10/11 ou 10/11/2026) são aceitas quando a data inteira aparece nos fatos.
  const factDates = new Set(
    [...factLines.join("\n").matchAll(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g)].map((m) => m[0]),
  );
  const text = answer.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, (d) =>
    factDates.has(d) ? " " : d,
  );
  for (const m of text.matchAll(NUMBER_RE)) {
    const token = m[0];
    const values = readingsOf(token);
    if (values.length === 0) continue;
    const okToken = values.some(
      (v) =>
        (Number.isInteger(v) && v >= 0 && v <= 31) ||
        (Number.isInteger(v) && v >= 2019 && v <= 2035) ||
        allowed.some((a) => near(v, a)),
    );
    if (!okToken) flagged.push(token);
  }
  return { ok: flagged.length === 0, flagged };
}

/**
 * Marca no texto os números que não estão nos fatos, em vez de descartar a resposta inteira.
 * Usado na ANÁLISE PROFUNDA: o raciocínio continua legível e o leitor vê exatamente o que não foi
 * conferido contra o BI. A resposta rápida continua sendo descartada (fallbackText).
 */
export function markAnswer(answer: string, flagged: string[]): string {
  if (flagged.length === 0) return answer;
  // Dos maiores para os menores, para "1.234,56" não ser marcado dentro de "1.234".
  const alvos = [...new Set(flagged)].sort((a, b) => b.length - a.length);
  let out = answer;
  for (const token of alvos) {
    const escapado = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\d,.⚠])${escapado}(?![\\d,.])`, "g"), `${token} ⚠`);
  }
  return `${out}\n\n⚠ Os valores marcados não foram conferidos contra os números do BI: trate-os como leitura da IA, não como dado oficial.`;
}

/** Texto-modelo quando a resposta é descartada: os mesmos fatos, sem redação da IA. */
export function fallbackText(factLines: string[]): string {
  const shown = factLines.slice(0, 8);
  return `Não consegui redigir uma resposta segura (um número não bateu com os fatos). Os números desta tela:\n${shown
    .map((l) => `• ${l}`)
    .join("\n")}`;
}
