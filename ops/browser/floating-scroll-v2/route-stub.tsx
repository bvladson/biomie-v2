import type { ComponentProps } from "react";

// The production PositionsPage is exercised; authentication/routing is not.
// This module is substituted only by this fixture's isolated Vite configuration.
export function getRouteApi() {
  return {
    useSearch: () => ({ view: "product" }),
    useNavigate: () => () => Promise.resolve(),
  };
}

export function Link({ to, params, search, ...props }: ComponentProps<"a"> & {
  to: string;
  params?: unknown;
  search?: unknown;
}) {
  return <a {...props} href={to} />;
}
