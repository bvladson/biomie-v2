import { createFileRoute } from "@tanstack/react-router";
import { RoutePage } from "@/flight-plan/pages/RoutePage";

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo/rota")({
  head: () => ({ meta: [{ title: "Plano de Voo — Rota — BIOMIE" }] }),
  component: RoutePage,
});
