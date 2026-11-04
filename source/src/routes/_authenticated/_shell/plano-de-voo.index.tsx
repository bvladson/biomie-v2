import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/flight-plan/pages/OverviewPage";

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo/")({
  head: () => ({ meta: [{ title: "Plano de Voo — Visão geral — BIOMIE" }] }),
  component: OverviewPage,
});
