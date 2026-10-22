import { createFileRoute } from "@tanstack/react-router";
import { SimulationPage } from "@/estoque/pages/SimulationPage";

export const Route = createFileRoute("/_authenticated/_shell/estoque/simulacao")({
  component: SimulationPage,
});
