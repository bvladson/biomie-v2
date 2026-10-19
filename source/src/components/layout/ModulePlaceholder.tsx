import { Link } from "@tanstack/react-router";
import { Construction } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ModulePlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Construction className="size-5" />
        </div>
        <h2 className="font-medium">Módulo em construção</h2>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
        <Button asChild variant="outline" size="sm" className="mt-2">
          <Link to="/cockpit">Voltar ao Cockpit</Link>
        </Button>
      </div>
    </main>
  );
}
