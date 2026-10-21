import { createFileRoute } from "@tanstack/react-router";
import { AdminSection } from "@/admin/components/AdminSection";
import { NewUserPage } from "@/admin/pages/NewUserPage";

export const Route = createFileRoute("/_authenticated/_shell/admin_/usuarios/novo")({
  head: () => ({ meta: [{ title: "Novo usuário — BIOMIE" }] }),
  component: () => (
    <AdminSection>
      <NewUserPage />
    </AdminSection>
  ),
});
