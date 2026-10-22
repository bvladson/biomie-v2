import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/components/entities/shared";
import { StockLayout } from "@/estoque/components/StockLayout";

export const Route = createFileRoute("/_authenticated/_shell/estoque")({
  head: () => pageHead("Estoque", "Posição de estoque do Omie, curvas e simulação de liquidação."),
  component: StockLayout,
});
