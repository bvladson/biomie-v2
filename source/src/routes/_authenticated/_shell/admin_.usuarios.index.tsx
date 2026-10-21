import { createFileRoute } from "@tanstack/react-router";
import { AdminSection } from "@/admin/components/AdminSection";
import { UsersPage } from "@/admin/pages/UsersPage";

export const Route = createFileRoute("/_authenticated/_shell/admin_/usuarios/")({
  head: () => ({ meta: [{ title: "Usuários — BIOMIE" }] }),
  component: () => (
    <AdminSection>
      <UsersPage />
    </AdminSection>
  ),
});
