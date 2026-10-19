import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand/BrandMark";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BIOMIE — Analytics Platform" },
      {
        name: "description",
        content:
          "Plataforma de inteligência comercial, financeira e operacional integrada ao seu ERP.",
      },
      { property: "og:title", content: "BIOMIE — Analytics Platform" },
      {
        property: "og:description",
        content:
          "Plataforma de inteligência comercial, financeira e operacional integrada ao seu ERP.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-7" />
          <span className="font-semibold tracking-tight">BIOMIE</span>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/auth">Entrar</Link>
        </Button>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 pb-24">
        <div className="eyebrow">Analytics Platform</div>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
          Uma fonte oficial para cada número da sua empresa.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Faturamento, metas, carteira, forecast e performance do time — com regras de negócio
          centralizadas e dados confiáveis.
        </p>
        <div className="mt-8 flex gap-3">
          <Button asChild size="lg">
            <Link to="/cockpit">
              Abrir o Cockpit <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
