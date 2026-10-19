import { createFileRoute } from "@tanstack/react-router";
import { ModulePlaceholder } from "@/components/layout/ModulePlaceholder";

export const Route = createFileRoute("/_authenticated/_shell/explorar")({
  head: () => ({
    meta: [
      { title: "Explorar Dados — BIOMIE" },
      {
        name: "description",
        content: "Exploração livre de datasets analíticos com filtros e exportação.",
      },
      { property: "og:title", content: "Explorar Dados — BIOMIE" },
      {
        property: "og:description",
        content: "Exploração livre de datasets analíticos com filtros e exportação.",
      },
    ],
  }),
  component: () => (
    <ModulePlaceholder
      title="Explorar Dados"
      description="Exploração livre de datasets analíticos com filtros e exportação."
    />
  ),
});
