import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useState } from "react";
import { flightPlanApi } from "../api";
import type { HistoryArea } from "../api/contract";
import { fpKey, useFilters } from "../lib/hooks";
import { dateTimeBr } from "../lib/format";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

/** Histórico das alterações (audit_log): quem mudou, quando, antes e depois. Lido só ao abrir. */
export function HistoryPanel({ area }: { area: HistoryArea }) {
  const f = useFilters();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: fpKey(f.persona, "history", f.company.id, area),
    queryFn: () => flightPlanApi.listHistory(f.company.id, area),
    enabled: open,
  });
  const list = q.data ?? [];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card p-4">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm">
          <History className="size-4" aria-hidden />
          Histórico{q.data ? ` (${list.length})` : ""}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">
        {q.isPending ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : q.isError ? (
          <p className="text-sm text-destructive">{q.error.message}</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma alteração registrada.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {list.map((e) => (
              <li key={e.id} className="rounded border p-2">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">
                    {e.action}: {e.target}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {e.author} · {dateTimeBr(e.at)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Antes: {e.before ?? "—"} → Depois: {e.after ?? "—"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
