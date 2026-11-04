import { createFileRoute } from "@tanstack/react-router";
import { FlightPlanShell } from "@/flight-plan/components/FlightPlanShell";

const description =
  "Plano de Voo Comercial: Destino (metas), Rota (iniciativas), Velocidade (ritmo), Painel (indicadores) e Correção de rota (alertas).";

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo")({
  head: () => ({
    meta: [
      { title: "Plano de Voo — BIOMIE" },
      { name: "description", content: description },
      { property: "og:title", content: "Plano de Voo — BIOMIE" },
      { property: "og:description", content: description },
    ],
  }),
  component: FlightPlanShell,
});
