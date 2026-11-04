import { brl0, pct0 } from "./format";

export function whatsappSummary(s: {
  company: string;
  weekStart: string;
  realized: number;
  attainment: number | null;
  forecast: number | null;
  atRisk: number;
  openActions: number;
  lateActions: number;
}) {
  const [, m, d] = s.weekStart.split("-");
  const parts = [
    `realizado ${brl0(s.realized)}${s.attainment !== null ? ` (${pct0(s.attainment)} da meta)` : " (sem meta)"}`,
    s.forecast !== null ? `previsão provável ${brl0(s.forecast)}` : null,
    `${s.atRisk} ${s.atRisk === 1 ? "vendedor" : "vendedores"} em risco`,
    `${s.openActions} ${s.openActions === 1 ? "ação aberta" : "ações abertas"}`,
    `${s.lateActions} ${s.lateActions === 1 ? "atrasada" : "atrasadas"}`,
  ].filter(Boolean);
  return `Plano de Voo ${s.company}, semana de ${d}/${m} (números do mês até hoje): ${parts.join(", ")}.`;
}
