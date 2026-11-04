import { createFileRoute } from "@tanstack/react-router";
import { VelocityPage } from "@/flight-plan/pages/VelocityPage";

export const Route = createFileRoute("/_authenticated/_shell/plano-de-voo/velocidade")({
  head: () => ({ meta: [{ title: "Plano de Voo — Velocidade — BIOMIE" }] }),
  component: VelocityPage,
});
