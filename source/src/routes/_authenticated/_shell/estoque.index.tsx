import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/estoque/pages/OverviewPage";

export const Route = createFileRoute("/_authenticated/_shell/estoque/")({
  component: OverviewPage,
});
