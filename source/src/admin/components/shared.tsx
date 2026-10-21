import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { adminApi, type Me } from "../api";

export const meQuery = { queryKey: ["admin", "me"], queryFn: () => adminApi.me() };
export const companiesQuery = {
  queryKey: ["admin", "companies"],
  queryFn: () => adminApi.listCompanies(),
};

export function useMe() {
  return useQuery(meQuery);
}
export function useCompanies() {
  return useQuery(companiesQuery);
}
export const isSuper = (me?: Me) => !!me?.roles.includes("SUPER_ADMIN");
export const isAdmin = (me?: Me) => isSuper(me) || !!me?.roles.includes("ADMIN");

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-4" role="status" aria-label="Carregando">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
      <AlertCircle className="size-6 text-destructive" aria-hidden />
      <p className="text-sm text-foreground">
        {error instanceof Error ? error.message : "Erro inesperado."}
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <Inbox className="size-6" aria-hidden />
      {children}
    </div>
  );
}

/** Envolve um controle desabilitado e explica o motivo em uma dica acessível por teclado. */
export function WithReason({ reason, children }: { reason?: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={reason} className="inline-flex rounded-md">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Erro inesperado.");
