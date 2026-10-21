import { createFileRoute } from "@tanstack/react-router";
import { AdminSection } from "@/admin/components/AdminSection";
import { CompaniesPage } from "@/admin/pages/CompaniesPage";

export const Route = createFileRoute("/_authenticated/_shell/admin_/empresas")({
  head: () => ({ meta: [{ title: "Empresas e calendário — BIOMIE" }] }),
  component: () => (
    <AdminSection>
      <CompaniesPage />
    </AdminSection>
  ),
});
