import { createFileRoute } from "@tanstack/react-router";
import { CorrectionPage } from "@/flight-plan/pages/CorrectionPage";

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo/correcao")({
  head: () => ({ meta: [{ title: "Plano de Voo — Correção de rota — BIOMIE" }] }),
  component: CorrectionPage,
});
