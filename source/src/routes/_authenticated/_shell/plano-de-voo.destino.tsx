import { createFileRoute } from "@tanstack/react-router";
import { TargetsPage } from "@/flight-plan/pages/TargetsPage";

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo/destino")({
  head: () => ({ meta: [{ title: "Plano de Voo — Destino — BIOMIE" }] }),
  component: TargetsPage,
});
