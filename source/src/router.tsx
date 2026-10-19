import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Access denied / not found is deterministic: show it immediately instead of retrying.
        retry: (count, error) =>
          !/sem acesso|não encontrad|unauthorized|forbidden/i.test(
            error instanceof Error ? error.message : "",
          ) && count < 2,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
