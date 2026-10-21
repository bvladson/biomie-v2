import { createFileRoute } from "@tanstack/react-router";
import { AdminSection } from "@/admin/components/AdminSection";
import { UserDetailPage } from "@/admin/pages/UserDetailPage";

export const Route = createFileRoute("/_authenticated/_shell/admin_/usuarios/$id")({
  head: () => ({ meta: [{ title: "Usuário — BIOMIE" }] }),
  component: UserRoute,
});

function UserRoute() {
  const { id } = Route.useParams();
  return (
    <AdminSection>
      <UserDetailPage key={id} id={id} />
    </AdminSection>
  );
}
