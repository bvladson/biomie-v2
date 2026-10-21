import { createFileRoute } from "@tanstack/react-router";
import { AdminSection } from "@/admin/components/AdminSection";
import { AuditPage } from "@/admin/pages/AuditPage";

export const Route = createFileRoute("/_authenticated/_shell/admin_/auditoria")({
  head: () => ({ meta: [{ title: "Auditoria — BIOMIE" }] }),
  component: () => (
    <AdminSection>
      <AuditPage />
    </AdminSection>
  ),
});
