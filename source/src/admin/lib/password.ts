export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string };

/** Indicador simples de força. Mínimo obrigatório: 10 caracteres. */
export function passwordStrength(p: string): Strength {
  if (!p) return { score: 0, label: "Vazia" };
  let s = 0;
  if (p.length >= 10) s++;
  if (p.length >= 14) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  if (p.length < 10) s = Math.min(s, 1);
  const score = s as Strength["score"];
  return { score, label: ["Muito fraca", "Fraca", "Razoável", "Boa", "Forte"][score] ?? "" };
}
