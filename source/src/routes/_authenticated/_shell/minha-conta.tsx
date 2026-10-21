import { createFileRoute } from "@tanstack/react-router";
import { AccountSection } from "@/admin/components/AdminSection";
import { MyAccountPage } from "@/admin/pages/MyAccountPage";

export const Route = createFileRoute("/_authenticated/_shell/minha-conta")({
  head: () => ({ meta: [{ title: "Minha conta — BIOMIE" }] }),
  component: () => (
    <AccountSection>
      <MyAccountPage />
    </AccountSection>
  ),
});
