import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { suppliersApi } from "../api/suppliers";
import { errorMessage } from "../lib/format";

const MIN_NOTE = 10;

function NoteField({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  hint: string;
}) {
  return (
    <label className="space-y-1.5 text-sm">
      <span className="block text-xs font-medium text-muted-foreground">
        Observação (10 a 300 caracteres) — {hint}
      </span>
      <Textarea value={value} maxLength={300} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export interface LeadTimeTarget {
  companyId: string;
  supplierId: string;
  supplierName: string;
  /** Sem produto = prazo padrão do fornecedor na empresa. */
  omieProductId?: string | undefined;
  productName?: string | null | undefined;
  current?: { leadTimeDays: number; minLot: number | null } | null | undefined;
}

/** Informar, alterar ou remover um prazo de entrega (dias corridos), sempre com observação. */
export function LeadTimeDialog({
  target,
  onClose,
  onSaved,
}: {
  target: LeadTimeTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [days, setDays] = useState("");
  const [lot, setLot] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LeadTimeTarget | null>(null);
  if (target !== last) {
    setLast(target);
    setDays(target?.current ? String(target.current.leadTimeDays) : "");
    setLot(target?.current?.minLot ? String(target.current.minLot) : "");
    setNote("");
  }
  const n = days.trim() === "" ? null : Number(days.trim());
  const l = lot.trim() === "" ? null : Number(lot.trim().replace(",", "."));
  const valid =
    n !== null &&
    Number.isInteger(n) &&
    n >= 1 &&
    n <= 365 &&
    (l === null || (Number.isFinite(l) && l > 0 && l <= 1_000_000)) &&
    note.trim().length >= MIN_NOTE;
  async function run(values: { leadTimeDays: number; minLot: number | null } | null) {
    if (!target) return;
    setBusy(true);
    try {
      await suppliersApi.setLeadTime({
        companyId: target.companyId,
        supplierId: target.supplierId,
        omieProductId: target.omieProductId,
        values,
        note: note.trim(),
      });
      toast.success(
        values
          ? "Prazo salvo. Vale a partir da próxima análise da Inteligência."
          : "Prazo removido.",
      );
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {target?.omieProductId ? "Prazo de entrega do produto" : "Prazo padrão do fornecedor"}
          </DialogTitle>
          <DialogDescription>
            {target?.omieProductId
              ? `${target.productName ?? target.omieProductId} com ${target.supplierName}. Prevalece sobre o prazo padrão do fornecedor.`
              : `${target?.supplierName ?? ""}: vale para os produtos dele nesta empresa que não têm prazo próprio.`}{" "}
            Dias corridos, do pedido à entrega. A mudança fica no histórico e na Auditoria.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="block text-xs font-medium text-muted-foreground">
              Prazo de entrega (dias corridos)
            </span>
            <Input
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-11 bg-card"
            />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="block text-xs font-medium text-muted-foreground">
              Lote mínimo de compra (opcional)
            </span>
            <Input
              inputMode="decimal"
              value={lot}
              onChange={(e) => setLot(e.target.value)}
              className="h-11 bg-card"
            />
          </label>
        </div>
        <NoteField value={note} onChange={setNote} hint="de onde veio o prazo" />
        <DialogFooter className="gap-2">
          {target?.current && (
            <Button
              variant="outline"
              disabled={busy || note.trim().length < MIN_NOTE}
              onClick={() => void run(null)}
            >
              Remover prazo
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={() => void run({ leadTimeDays: n!, minLot: l })}
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface NoteAction {
  title: string;
  description: string;
  confirm: string;
  destructive?: boolean | undefined;
  hint: string;
  run: (note: string) => Promise<unknown>;
  done: string;
}

/** Confirmação com observação obrigatória (fornecedor principal, vínculo manual). */
export function NoteActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: NoteAction | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<NoteAction | null>(null);
  if (action !== last) {
    setLast(action);
    setNote("");
  }
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action?.title}</DialogTitle>
          <DialogDescription>{action?.description}</DialogDescription>
        </DialogHeader>
        <NoteField value={note} onChange={setNote} hint={action?.hint ?? "o motivo"} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant={action?.destructive ? "destructive" : "default"}
            disabled={busy || note.trim().length < MIN_NOTE}
            onClick={async () => {
              if (!action) return;
              setBusy(true);
              try {
                await action.run(note.trim());
                toast.success(action.done);
                onDone();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {action?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
