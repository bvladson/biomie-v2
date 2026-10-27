import { createFileRoute } from "@tanstack/react-router";
import { SuppliersPage } from "@/estoque/pages/SuppliersPage";

export const Route = createFileRoute("/_authenticated/_shell/estoque/fornecedores")({
  component: SuppliersPage,
});
