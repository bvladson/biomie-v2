import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old path kept working: Qualidade dos Dados now lives at /qualidade-dos-dados. */
export const Route = createFileRoute("/_authenticated/_shell/qualidade")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/qualidade-dos-dados", search: search as never, replace: true });
  },
});
