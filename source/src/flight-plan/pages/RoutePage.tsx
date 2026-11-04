import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import type {
  Initiative,
  InitiativeStatus,
  Lever,
  TargetList,
  TargetListKind,
} from "../api/contract";
import { flightPlanApi } from "../api";
import { brl0, dateBr, pct } from "../lib/format";
import { canCreateInitiative, canEditInitiative } from "../lib/permissions";
import { keepSearch } from "@/components/entities/shared";
import { fpKey, useFilters, useMe, useSellers } from "../lib/hooks";
import { ErrorState, Loading, Panel, TableWrap, td, tdR, th, thR } from "../components/bits";
import { InitiativeDialog, LEVER_PT, type InitiativeDraft } from "../components/InitiativeDialog";
import { HistoryPanel } from "../components/HistoryPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { parseMoneyInput } from "../lib/grid";

export const INIT_STATUS_PT: Record<InitiativeStatus, string> = {
  PLANNED: "Planejada",
  IN_PROGRESS: "Em andamento",
  DONE: "Concluída",
  CANCELLED: "Cancelada",
};
const LIST_LEVER: Record<TargetListKind, Lever> = {
  OPEN_QUOTES: "CONVERT_QUOTES",
  INACTIVE_CUSTOMERS: "REACTIVATE_CUSTOMERS",
  LATE_ORDERS: "OTHER",
  IDLE_STOCK: "PRODUCT_CAMPAIGN",
};
export const isLate = (i: Initiative, today: string) =>
  i.dueDate < today && i.status !== "DONE" && i.status !== "CANCELLED";

export function RoutePage() {
  const f = useFilters();
  const me = useMe();
  const sellers = useSellers();
  const q = useQuery({
    queryKey: fpKey(f.persona, "initiatives", f.query),
    queryFn: () => flightPlanApi.listInitiatives(f.query),
  });
  const lists = useQuery({
    queryKey: fpKey(f.persona, "lists", f.query),
    queryFn: () => flightPlanApi.getTargetLists(f.query),
  });
  const [dialog, setDialog] = useState<InitiativeDraft | Initiative | null>(null);
  const [statusFilter, setStatusFilter] = useState("all"),
    [leverFilter, setLeverFilter] = useState("all"),
    [ownerFilter, setOwnerFilter] = useState("all");
  const [statusAction, setStatusAction] = useState<{ it: Initiative; to: InitiativeStatus } | null>(
    null,
  );
  const [openList, setOpenList] = useState<TargetList | null>(null);
  if (q.isPending || me.isPending) return <Loading label="Carregando plano de ação…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (me.isError) return <ErrorState error={me.error} retry={() => me.refetch()} />;
  const today = f.company.asOf;
  const cov = q.data.coverage;
  const canCreate = canCreateInitiative(me.data);
  const canWrite = (i: Initiative) => canEditInitiative(me.data, i);
  const owners = [...new Map(q.data.rows.map((i) => [i.ownerUserId, i.ownerName])).entries()];
  const rows = q.data.rows.filter(
    (i) =>
      (statusFilter === "all" ||
        (statusFilter === "LATE" ? isLate(i, today) : i.status === statusFilter)) &&
      (leverFilter === "all" || i.lever === leverFilter) &&
      (ownerFilter === "all" || i.ownerUserId === ownerFilter),
  );
  return (
    <div className="space-y-5">
      <Panel>
        <p className="text-lg font-semibold" aria-live="polite">
          {cov.remainingGap === null
            ? "Sem meta: não há gap para cobrir."
            : cov.remainingGap === 0
              ? "Meta atingida."
              : `O plano cobre ${pct(cov.coverage)} do que falta. ${brl0(cov.uncovered)} ainda sem ação definida.`}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Falta {brl0(cov.remainingGap)} · planejado {brl0(cov.plannedAmount)} · {cov.open} abertas
          · {cov.late} atrasadas
        </p>
      </Panel>

      <Panel
        title="Iniciativas do mês"
        action={
          canCreate && (
            <Button size="sm" onClick={() => setDialog({})}>
              <Plus className="size-4" aria-hidden />
              Nova iniciativa
            </Button>
          )
        }
      >
        <div className="mb-3 flex flex-wrap gap-3">
          <FilterSelect
            id="rf-status"
            label="Status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[["all", "Todos"], ...Object.entries(INIT_STATUS_PT), ["LATE", "Atrasadas"]]}
          />
          <FilterSelect
            id="rf-lever"
            label="Alavanca"
            value={leverFilter}
            onChange={setLeverFilter}
            options={[["all", "Todas"], ...Object.entries(LEVER_PT)]}
          />
          <FilterSelect
            id="rf-owner"
            label="Responsável"
            value={ownerFilter}
            onChange={setOwnerFilter}
            options={[["all", "Todos"], ...owners]}
          />
        </div>
        {rows.length === 0 ? (
          <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">
            Nenhuma iniciativa neste filtro.
          </p>
        ) : (
          <TableWrap label="Iniciativas">
            <thead>
              <tr>
                <th className={th}>Título</th>
                <th className={th}>Alavanca</th>
                <th className={th}>Responsável</th>
                <th className={th}>Prazo</th>
                <th className={thR}>Esperado</th>
                <th className={th}>Status</th>
                <th className={thR}>Resultado</th>
                <th className={th}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className={td}>
                    {i.title}
                    {i.alertKey && (
                      <span className="ml-2 rounded bg-accent px-1.5 text-[10px] font-semibold">
                        ação corretiva
                      </span>
                    )}
                  </td>
                  <td className={td}>{LEVER_PT[i.lever]}</td>
                  <td className={td}>{i.ownerName}</td>
                  <td className={td}>
                    {dateBr(i.dueDate)}
                    {isLate(i, today) && (
                      <span className="ml-2 rounded border border-destructive/40 px-1.5 text-[10px] font-semibold text-destructive">
                        Atrasada
                      </span>
                    )}
                  </td>
                  <td className={tdR}>{brl0(i.expectedAmount)}</td>
                  <td className={td}>{INIT_STATUS_PT[i.status]}</td>
                  <td className={tdR}>{brl0(i.realizedAmount)}</td>
                  <td className={td}>
                    {canWrite(i) && i.status !== "DONE" && i.status !== "CANCELLED" ? (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setDialog(i)}>
                          Editar
                        </Button>
                        {i.status === "PLANNED" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setStatusAction({ it: i, to: "IN_PROGRESS" })}
                          >
                            Iniciar
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setStatusAction({ it: i, to: "DONE" })}
                        >
                          Concluir
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setStatusAction({ it: i, to: "CANCELLED" })}
                        >
                          Cancelar
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel title="Listas para atacar">
        {lists.isPending ? (
          <Loading label="Gerando listas…" />
        ) : lists.isError ? (
          <ErrorState error={lists.error} retry={() => lists.refetch()} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {lists.data.map((l) =>
              l.kind === "IDLE_STOCK" ? (
                <Link
                  key={l.kind}
                  to="/estoque/inteligencia"
                  search={keepSearch}
                  className="rounded-lg border bg-card p-4 text-left hover:border-primary"
                >
                  <p className="text-sm font-semibold">{l.title}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Curva D, tempo sem venda e custo ficam em Estoque › Inteligência.
                  </p>
                  <p className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Abrir no Estoque
                  </p>
                </Link>
              ) : (
                <button
                  key={l.kind}
                  type="button"
                  onClick={() => setOpenList(l)}
                  className="rounded-lg border bg-card p-4 text-left hover:border-primary"
                >
                  <p className="text-sm font-semibold">{l.title}</p>
                  <p className="fp-num mt-2 text-xl font-semibold">{l.count}</p>
                  <p className="fp-num text-sm text-muted-foreground">{brl0(l.amount)}</p>
                </button>
              ),
            )}
          </div>
        )}
      </Panel>

      <HistoryPanel area="rota" />

      <Sheet open={!!openList} onOpenChange={(o) => !o && setOpenList(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {openList && (
            <>
              <SheetHeader>
                <SheetTitle>{openList.title}</SheetTitle>
                <SheetDescription>
                  {openList.count} itens · {brl0(openList.amount)}
                </SheetDescription>
              </SheetHeader>
              {canCreate && openList.count > 0 && (
                <Button
                  className="my-3"
                  onClick={() => {
                    const l = openList;
                    setOpenList(null);
                    setDialog({
                      title: l.title,
                      lever: LIST_LEVER[l.kind],
                      targetListKind: l.kind,
                      sellerIds: [
                        ...new Set(l.items.map((x) => x.sellerId).filter((x): x is string => !!x)),
                      ],
                    });
                  }}
                >
                  Criar iniciativa com esta lista
                </Button>
              )}
              <ul className="space-y-1 text-sm">
                {openList.items.slice(0, 200).map((it) => (
                  <li key={it.id} className="flex justify-between gap-2 border-b py-1.5">
                    <span>
                      <span className="font-medium">{it.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {it.detail}
                        {it.ageDays !== null ? ` · ${it.ageDays} dias` : ""}
                      </span>
                    </span>
                    <span className="fp-num">{brl0(it.amount)}</span>
                  </li>
                ))}
              </ul>
              {openList.count > Math.min(openList.items.length, 200) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Mostrando os {Math.min(openList.items.length, 200)} maiores de {openList.count}.
                </p>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      <InitiativeDialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        draft={dialog}
        me={me.data}
        sellers={sellers.data ?? []}
      />
      <StatusDialog action={statusAction} close={() => setStatusAction(null)} />
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9 w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function StatusDialog({
  action,
  close,
}: {
  action: { it: Initiative; to: InitiativeStatus } | null;
  close: () => void;
}) {
  const f = useFilters();
  const client = useQueryClient();
  const [amount, setAmount] = useState(""),
    [note, setNote] = useState("");
  const parsed = parseMoneyInput(amount);
  const m = useMutation({
    mutationFn: () =>
      flightPlanApi.setInitiativeStatus(
        action!.it.id,
        action!.to,
        action!.to === "DONE" && parsed.ok ? parsed.value : null,
        note.trim() || null,
      ),
    onSuccess: () => {
      toast.success("Status atualizado");
      client.invalidateQueries({ queryKey: fpKey(f.persona) });
      setAmount("");
      setNote("");
      close();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });
  const done = action?.to === "DONE",
    cancel = action?.to === "CANCELLED";
  const valid = done ? parsed.ok && parsed.value !== null : cancel ? !!note.trim() : true;
  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) m.mutate();
          }}
          className="space-y-3"
        >
          <DialogHeader>
            <DialogTitle>
              {done ? "Concluir iniciativa" : cancel ? "Cancelar iniciativa" : "Iniciar iniciativa"}
            </DialogTitle>
            <DialogDescription>{action?.it.title}</DialogDescription>
          </DialogHeader>
          {done && (
            <div className="grid gap-1">
              <Label htmlFor="st-amount">Resultado em R$ *</Label>
              <Input
                id="st-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          )}
          {(done || cancel) && (
            <div className="grid gap-1">
              <Label htmlFor="st-note">{cancel ? "Motivo *" : "Nota"}</Label>
              <Textarea id="st-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Voltar
            </Button>
            <Button type="submit" disabled={!valid || m.isPending}>
              Confirmar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
