import { createFileRoute } from "@tanstack/react-router";
import { ModulePlaceholder } from "@/components/layout/ModulePlaceholder";

export const Route = createFileRoute("/_authenticated/_shell/forecast")({
  head: () => ({
    meta: [
      { title: "Forecast — BIOMIE" },
      { name: "description", content: "Projeções de fechamento por empresa, canal e vendedor." },
      { property: "og:title", content: "Forecast — BIOMIE" },
      {
        property: "og:description",
        content: "Projeções de fechamento por empresa, canal e vendedor.",
      },
    ],
  }),
  component: () => (
    <ModulePlaceholder
      title="Forecast"
      description="Projeções de fechamento por empresa, canal e vendedor."
    />
  ),
});
