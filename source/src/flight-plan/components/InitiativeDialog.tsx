import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Initiative, InitiativeInput, Lever, Me, Seller } from "../api/contract";
import { flightPlanApi } from "../api";
import { fpKey, useFilters } from "../lib/hooks";
import { formatInputMoney, parseMoneyInput } from "../lib/grid";
import { addDays, monthEnd } from "../lib/dates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Checkbox } from "@/components/ui/checkbox";

export const LEVER_PT: Record<Lever, string> = {
  CONVERT_QUOTES: "Converter orçamentos",
  REACTIVATE_CUSTOMERS: "Reativar clientes",
  EXPAND_MIX: "Ampliar mix do cliente",
  PRODUCT_CAMPAIGN: "Campanha de produto",
  PUBLIC_BIDS: "Licitações",
  PROSPECTING: "Prospecção",
  OTHER: "Outra",
};

export type InitiativeDraft = Partial<InitiativeInput>;

export function InitiativeDialog({
  open,
  onOpenChange,
  draft,
  me,
  sellers,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  draft: InitiativeDraft | Initiative | null;
  me: Me;
  sellers: Seller[];
  onSaved?: (i: Initiative) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {open && (
          <Form
            key={JSON.stringify(draft)}
            draft={draft ?? {}}
            me={me}
            sellers={sellers}
            close={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  draft,
  me,
  sellers,
  close,
  onSaved,
}: {
  draft: InitiativeDraft;
  me: Me;
  sellers: Seller[];
  close: () => void;
  onSaved?: ((i: Initiative) => void) | undefined;
}) {
  const f = useFilters();
  const client = useQueryClient();
  const isSeller = me.roles.includes("VENDEDOR") && !!me.sellerId;
  // Responsável: a própria pessoa ou qualquer vendedor da empresa, com ou sem login (decisão de 04/11).
  const owners = [
    { id: `user:${me.userId}`, name: `${me.name || "Eu"} (eu)` },
    ...sellers
      .filter((s) => s.active || draft.ownerUserId === `seller:${s.id}`)
      .map((s) => ({
        id: `seller:${s.id}`,
        name: s.name,
      })),
  ];
  const [title, setTitle] = useState(draft.title ?? "");
  const [lever, setLever] = useState<Lever | "">(draft.lever ?? "");
  const [owner, setOwner] = useState(draft.ownerUserId ?? `user:${me.userId}`);
  const [sellerIds, setSellerIds] = useState<string[]>(
    draft.sellerIds ?? (isSeller ? [me.sellerId!] : []),
  );
  const [due, setDue] = useState(draft.dueDate ?? "");
  const [amount, setAmount] = useState(formatInputMoney(draft.expectedAmount ?? null));
  const [notes, setNotes] = useState(draft.notes ?? "");
  const parsed = parseMoneyInput(amount);
  const minDue = `${f.month}-01`,
    maxDue = addDays(monthEnd(f.month), 30);
  const errors: string[] = [];
  if (!title.trim()) errors.push("título");
  if (!lever) errors.push("alavanca");
  if (!due) errors.push("prazo");
  if (!parsed.ok || !parsed.value) errors.push("valor esperado");
  const save = useMutation({
    mutationFn: () =>
      flightPlanApi.saveInitiative({
        ...(draft.id ? { id: draft.id } : {}),
        companyId: f.company.id,
        month: f.month,
        title: title.trim(),
        lever: lever as Lever,
        ownerUserId: owner,
        sellerIds,
        dueDate: due,
        expectedAmount: parsed.ok && parsed.value ? parsed.value : 0,
        realizedAmount: draft.realizedAmount ?? null,
        status: draft.status ?? "PLANNED",
        alertKey: draft.alertKey ?? null,
        targetListKind: draft.targetListKind ?? null,
        notes: notes.trim() || null,
      }),
    onSuccess: (i) => {
      toast.success("Iniciativa salva");
      client.invalidateQueries({ queryKey: fpKey(f.persona) });
      onSaved?.(i);
      close();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!errors.length) save.mutate();
      }}
      className="space-y-3"
    >
      <DialogHeader>
        <DialogTitle>
          {draft.id
            ? "Editar iniciativa"
            : draft.alertKey
              ? "Criar ação corretiva"
              : "Nova iniciativa"}
        </DialogTitle>
        <DialogDescription>
          Campos com * são obrigatórios. Prazo dentro do mês ou até 30 dias depois.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1">
        <Label htmlFor="in-title">Título *</Label>
        <Input id="in-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor="in-lever">Alavanca *</Label>
          <Select value={lever} onValueChange={(v) => setLever(v as Lever)}>
            <SelectTrigger id="in-lever">
              <SelectValue placeholder="Escolha" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LEVER_PT) as Lever[]).map((l) => (
                <SelectItem key={l} value={l}>
                  {LEVER_PT[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="in-owner">Responsável *</Label>
          <Select value={owner} onValueChange={setOwner} disabled={isSeller}>
            <SelectTrigger id="in-owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {owners.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="in-due">Prazo *</Label>
          <Input
            id="in-due"
            type="date"
            min={minDue}
            max={maxDue}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="in-amount">Valor esperado (R$) *</Label>
          <Input
            id="in-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!parsed.ok}
          />
          {!parsed.ok && <span className="text-xs text-destructive">{parsed.error}</span>}
        </div>
      </div>
      {!isSeller && (
        <fieldset className="grid gap-1">
          <legend className="text-sm font-medium">Vendedores</legend>
          <div className="grid max-h-36 grid-cols-1 gap-1 overflow-y-auto rounded border p-2 sm:grid-cols-2">
            {sellers
              .filter((s) => s.active)
              .map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={sellerIds.includes(s.id)}
                    onCheckedChange={(c) =>
                      setSellerIds((ids) => (c ? [...ids, s.id] : ids.filter((x) => x !== s.id)))
                    }
                  />
                  {s.name}
                </label>
              ))}
          </div>
        </fieldset>
      )}
      <div className="grid gap-1">
        <Label htmlFor="in-notes">Notas</Label>
        <Textarea id="in-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {errors.length > 0 && (
        <p className="text-xs text-muted-foreground">Falta preencher: {errors.join(", ")}.</p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancelar
        </Button>
        <Button type="submit" disabled={errors.length > 0 || save.isPending}>
          {save.isPending ? "Salvando…" : "Salvar"}
        </Button>
      </DialogFooter>
    </form>
  );
}
