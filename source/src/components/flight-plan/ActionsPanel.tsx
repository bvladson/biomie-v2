import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, CircleDot, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { updateActionStatus } from "@/lib/flight-plan.functions";
import type { FlightPlanAction } from "@/lib/repositories/flight-plan.repository.server";
import { cn } from "@/lib/utils";

const PRIORITY = {
  1: { label: "Alta", cls: "text-destructive border-destructive/30" },
  2: { label: "Média", cls: "text-risk border-risk/30" },
  3: { label: "Baixa", cls: "text-muted-foreground" },
} as const;
const STATUS_LABEL = {
  OPEN: "Aberta",
  IN_PROGRESS: "Em andamento",
  RESOLVED: "Resolvida",
} as const;

export function ActionsPanel({
  actions,
  company,
  period,
  canWrite,
  onSelectSeller,
  limit = 12,
}: {
  actions: FlightPlanAction[];
  company: string;
  period: string;
  canWrite: boolean;
  onSelectSeller?: (id: string) => void;
  limit?: number;
}) {
  const qc = useQueryClient();
  const fn = useServerFn(updateActionStatus);
  const mut = useMutation({
    mutationFn: (v: { a: FlightPlanAction; status: FlightPlanAction["status"] }) =>
      fn({
        data: {
          company,
          period,
          seller: v.a.sellerId,
          type: v.a.type,
          priority: v.a.priority,
          message: v.a.message,
          status: v.status,
        },
      }),
    onSuccess: () =>
      qc
        .invalidateQueries({ queryKey: ["flight-plan"] })
        .then(() => qc.invalidateQueries({ queryKey: ["flight-plan-vendor"] })),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao atualizar ação"),
  });

  if (!actions.length)
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        Nenhuma ação necessária para o período e filtros atuais.
      </p>
    );

  return (
    <ul className="divide-y">
      {actions.slice(0, limit).map((a) => (
        <li
          key={a.key}
          className={cn(
            "flex flex-wrap items-center gap-3 px-4 py-3 md:px-5",
            a.status === "RESOLVED" && "opacity-60",
          )}
        >
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
              PRIORITY[a.priority].cls,
            )}
          >
            {PRIORITY[a.priority].label}
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm", a.status === "RESOLVED" && "line-through")}>{a.message}</p>
            <p className="text-xs text-muted-foreground">
              {a.sellerId && onSelectSeller ? (
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => onSelectSeller(a.sellerId!)}
                >
                  {a.sellerName}
                </button>
              ) : (
                (a.sellerName ?? "Empresa")
              )}{" "}
              · {STATUS_LABEL[a.status]}
            </p>
          </div>
          {canWrite && (
            <div className="flex gap-1">
              {a.status === "OPEN" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs"
                  disabled={mut.isPending}
                  onClick={() => mut.mutate({ a, status: "IN_PROGRESS" })}
                >
                  <PlayCircle className="size-3.5" /> Iniciar
                </Button>
              )}
              {a.status !== "RESOLVED" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs"
                  disabled={mut.isPending}
                  onClick={() => mut.mutate({ a, status: "RESOLVED" })}
                >
                  <CheckCircle2 className="size-3.5" /> Resolver
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs"
                  disabled={mut.isPending}
                  onClick={() => mut.mutate({ a, status: "OPEN" })}
                >
                  <CircleDot className="size-3.5" /> Reabrir
                </Button>
              )}
            </div>
          )}
        </li>
      ))}
      {actions.length > limit && (
        <li className="px-5 py-2 text-xs text-muted-foreground">
          +{actions.length - limit} ações adicionais
        </li>
      )}
    </ul>
  );
}
