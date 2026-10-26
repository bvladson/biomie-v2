import { createFileRoute } from "@tanstack/react-router";
import { validateIntelSearch } from "@/estoque/lib/intel-search";
import { IntelligencePage } from "@/estoque/pages/IntelligencePage";

export const Route = createFileRoute("/_authenticated/_shell/estoque/inteligencia")({
  validateSearch: validateIntelSearch,
  component: IntelligencePage,
});
