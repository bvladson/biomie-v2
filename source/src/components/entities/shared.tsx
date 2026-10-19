import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Keeps every global filter (company, period, ...) when drilling down. */
export const keepSearch = ((p: Record<string, unknown>) => p) as never;
export const withSearch = (extra: Record<string, unknown>) =>
  ((p: Record<string, unknown>) => ({ ...p, ...extra })) as never;

export const fmtDate = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";

export function pageHead(title: string, description: string) {
  return {
    meta: [
      { title: `${title} — BIOMIE` },
      { name: "description", content: description },
      { property: "og:title", content: `${title} — BIOMIE` },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  };
}

export function BackLink({ to, label }: { to: "/clientes" | "/produtos"; label: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link to={to} search={keepSearch}>
        <ArrowLeft className="size-4" /> {label}
      </Link>
    </Button>
  );
}

export function PageSkeleton() {
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-8 md:px-6">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-32" />
      <Skeleton className="h-80" />
    </main>
  );
}

export function Panel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      {children}
    </section>
  );
}

export const UNASSIGNED = "Não atribuído";
