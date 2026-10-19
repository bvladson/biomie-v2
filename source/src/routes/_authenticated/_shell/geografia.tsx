import { createFileRoute } from "@tanstack/react-router";
import { ModulePlaceholder } from "@/components/layout/ModulePlaceholder";

export const Route = createFileRoute("/_authenticated/_shell/geografia")({
  head: () => ({
    meta: [
      { title: "Geografia — BIOMIE" },
      { name: "description", content: "Resultado por estado, cidade e região." },
      { property: "og:title", content: "Geografia — BIOMIE" },
      { property: "og:description", content: "Resultado por estado, cidade e região." },
    ],
  }),
  component: () => (
    <ModulePlaceholder title="Geografia" description="Resultado por estado, cidade e região." />
  ),
});
