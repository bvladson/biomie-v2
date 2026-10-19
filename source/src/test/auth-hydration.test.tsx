import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";

function makeRouter() {
  return createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: ["/auth"] }),
  });
}

afterEach(cleanup);

describe("Sign-in form before hydration", () => {
  it("server-rendered submit button is disabled (no native reload)", async () => {
    const router = makeRouter();
    await router.load();
    const html = renderToString(<RouterProvider router={router} />);
    const button = /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain("disabled");
  });

  it("enables the submit button once hydrated", async () => {
    render(<RouterProvider router={makeRouter()} />);
    const btn = await screen.findByRole("button", { name: "Entrar" });
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(screen.getByLabelText("Senha")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Senha")).toHaveAttribute("minlength", "1");
    expect(screen.getByLabelText("E-mail ou usuário")).toHaveAttribute("type", "text");
  });
});
