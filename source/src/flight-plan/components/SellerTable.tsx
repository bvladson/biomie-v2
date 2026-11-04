import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { FlightPlan, Me, SellerRow } from "../api/contract";
import { flightPlanApi } from "../api";
import { brl0, dateTimeBr, pct } from "../lib/format";
import { canEditCommit } from "../lib/permissions";
import { fpKey, useFilters, useMe, usePlan } from "../lib/hooks";
import { Kpi, StatusBadge, TableWrap, td, tdR, th, thR, Loading, ErrorState } from "./bits";
import { FlightLineChart } from "./FlightLineChart";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { parseMoneyInput, formatInputMoney } from "../lib/grid";

export function SellerTable({ plan }: { plan: FlightPlan }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<SellerRow | null>(null);
  const rows = (all ? plan.sellers : plan.sellers.filter((s) => s.hasActivity))
    .slice()
    .sort(
      (a, b) =>
        (b.metrics.attainment ?? -1) - (a.metrics.attainment ?? -1) ||
        b.metrics.realized - a.metrics.realized,
    );
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Switch id="fp-show-all" checked={all} onCheckedChange={setAll} />
        <Label htmlFor="fp-show-all">Mostrar todos ({plan.sellers.length})</Label>
        <span className="text-xs text-muted-foreground">
          Por padrão: vendedores com meta, venda ou carteira no mês.
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Nenhum vendedor com meta, venda ou carteira neste filtro.
        </p>
      ) : (
        <TableWrap label="Vendedores do plano">
          <thead>
            <tr>
              <th className={th}>Vendedor</th>
              <th className={th}>Status</th>
              <th className={thR}>Meta</th>
              <th className={thR}>Realizado</th>
              <th className={thR}>% meta</th>
              <th className={thR}>Desvio</th>
              <th className={thR}>Ritmo nec./dia</th>
              <th className={thR}>Previsão provável</th>
              <th className={thR}>Carteira</th>
              <th className={thR}>Pedidos atrasados</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seller.id} className="hover:bg-muted/50">
                <td className={td}>
                  <button
                    type="button"
                    className="text-left font-medium text-primary underline-offset-2 hover:underline"
                    onClick={() => setOpen(r)}
                  >
                    {r.seller.name}
                  </button>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {r.seller.channel === "licitacao" ? "Licitação" : "Varejo"}
                  </span>
                </td>
                <td className={td}>
                  <StatusBadge status={r.metrics.status} />
                </td>
                <td className={tdR}>
                  {r.metrics.target === null ? "Sem meta" : brl0(r.metrics.target)}
                </td>
                <td className={tdR}>{brl0(r.metrics.realized)}</td>
                <td className={tdR}>{pct(r.metrics.attainment)}</td>
                <td
                  className={
                    tdR +
                    (r.metrics.deviation !== null && r.metrics.deviation < 0
                      ? " text-destructive"
                      : "")
                  }
                >
                  {brl0(r.metrics.deviation)}
                </td>
                <td className={tdR}>
                  {r.metrics.gapUnreachable ? "Inalcançável" : brl0(r.metrics.requiredDailyPace)}
                </td>
                <td className={tdR}>{brl0(r.metrics.forecastProbable)}</td>
                <td className={tdR}>{brl0(r.metrics.portfolio)}</td>
                <td className={tdR}>
                  {r.lateOrders > 0 ? <span className="text-destructive">{r.lateOrders}</span> : 0}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {open && <SellerPlan row={open} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

function SellerPlan({ row }: { row: SellerRow }) {
  const f = useFilters();
  const q = { ...f.query, sellerId: row.seller.id };
  const plan = usePlan(q);
  const me = useMe();
  return (
    <>
      <SheetHeader>
        <SheetTitle>{row.seller.name}</SheetTitle>
        <SheetDescription>
          Plano do vendedor no mês, com os mesmos blocos da empresa.
        </SheetDescription>
      </SheetHeader>
      <div className="mt-4 space-y-4">
        {plan.isPending ? (
          <Loading />
        ) : plan.isError ? (
          <ErrorState error={plan.error} retry={() => plan.refetch()} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <StatusBadge status={plan.data.summary.status} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Kpi
                label="Meta Ativa"
                value={
                  plan.data.summary.target === null ? "Sem meta" : brl0(plan.data.summary.target)
                }
                metric="target"
              />
              <Kpi
                label="Realizado"
                value={brl0(plan.data.summary.realized)}
                sub={pct(plan.data.summary.attainment) + " da meta"}
                metric="realized"
              />
              <Kpi
                label="Ritmo necessário"
                value={brl0(plan.data.summary.requiredDailyPace)}
                sub={`atual ${brl0(plan.data.summary.currentDailyPace)}/dia`}
                metric="requiredPace"
              />
              <Kpi
                label="Previsão provável"
                value={brl0(plan.data.summary.forecastProbable)}
                metric="forecastProbable"
              />
            </div>
            <FlightLineChart data={plan.data.timeline} height={220} />
          </>
        )}
        {me.data && <CommitEditor row={row} me={me.data} />}
      </div>
    </>
  );
}

function CommitEditor({ row, me }: { row: SellerRow; me: Me }) {
  const f = useFilters();
  const client = useQueryClient();
  const canEdit = canEditCommit(me, row.seller.id);
  const [value, setValue] = useState(formatInputMoney(row.commit?.amount ?? null));
  const [note, setNote] = useState(row.commit?.note ?? "");
  const parsed = parseMoneyInput(value);
  const save = useMutation({
    mutationFn: () =>
      flightPlanApi.setCommit(
        { ...f.query, sellerId: row.seller.id },
        parsed.ok ? parsed.value : null,
        note.trim() || null,
      ),
    onSuccess: () => {
      toast.success("Commit salvo");
      client.invalidateQueries({ queryKey: fpKey(f.persona) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });
  return (
    <form
      className="space-y-2 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.ok) save.mutate();
      }}
    >
      <h3 className="font-semibold">Commit do vendedor</h3>
      <p className="text-xs text-muted-foreground">
        Valor que o vendedor se compromete a faturar no mês. Soma na "Previsão comprometida".
        {row.commit && ` Atualizado em ${dateTimeBr(row.commit.updatedAt)}.`}
      </p>
      {canEdit ? (
        <>
          <Label htmlFor="fp-commit">Valor (R$)</Label>
          <Input
            id="fp-commit"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={!parsed.ok}
            aria-describedby="fp-commit-err"
          />
          {!parsed.ok && (
            <p id="fp-commit-err" className="text-xs text-destructive">
              {parsed.error}
            </p>
          )}
          <Label htmlFor="fp-commit-note">Nota</Label>
          <Textarea
            id="fp-commit-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <Button type="submit" disabled={!parsed.ok || save.isPending}>
            {save.isPending ? "Salvando…" : "Salvar commit"}
          </Button>
        </>
      ) : (
        <>
          <p className="fp-num text-lg font-semibold">
            {row.commit ? brl0(row.commit.amount) : "Sem commit"}
          </p>
          {row.commit?.note && <p className="text-sm">{row.commit.note}</p>}
          <p className="text-xs text-muted-foreground">
            Somente o próprio vendedor e o gestor dele editam o commit.
          </p>
        </>
      )}
    </form>
  );
}
