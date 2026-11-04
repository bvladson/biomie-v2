import { createFileRoute } from "@tanstack/react-router";
import { PanelPage } from "@/flight-plan/pages/PanelPage";

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo/painel")({
  head: () => ({ meta: [{ title: "Plano de Voo — Painel — BIOMIE" }] }),
  component: PanelPage,
});
