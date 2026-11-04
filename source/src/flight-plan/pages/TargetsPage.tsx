import { useMemo, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  Channel,
  TargetChange,
  TargetLevel,
  TargetPreview,
  TargetsMonth,
} from "../api/contract";
import { flightPlanApi } from "../api";
import { brl0, monthLabel, monthShort, pct } from "../lib/format";
import { fpKey, useFilters, usePeriodMonths, usePlan } from "../lib/hooks";
import { formatInputMoney, parseMoneyInput, parsePastedBlock } from "../lib/grid";
import { adjustedUndistributed, displayOrder, nextEditable, planPaste } from "../lib/targets-grid";
import { missingTargetLabel, partialPeriod, workdaysLabel, yearOf } from "../lib/period";
import { ErrorState, Loading, Panel, TableWrap, td, tdR, th, thR } from "../components/bits";
import { HistoryPanel } from "../components/HistoryPanel";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const LEVELS: TargetLevel[] = ["BASE", "ACTIVE", "CHALLENGE"];
const LEVEL_PT: Record<TargetLevel, string> = {
  BASE: "Base",
  ACTIVE: "Ativa",
  CHALLENGE: "Desafio",
};
const CH_PT = (c: Channel | null) =>
  c === "varejo" ? "Varejo" : c === "licitacao" ? "Licitação" : "Empresa toda";

export function TargetsPage() {
  const f = useFilters();
  const q = useQuery({
    queryKey: fpKey(f.persona, "targets", f.company.id, f.month),
    queryFn: () => flightPlanApi.getTargets(f.company.id, f.month),
  });
  if (q.isPending) return <Loading label="Carregando metas…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="space-y-5">
      <TargetsEditor key={JSON.stringify(q.data)} data={q.data} />
      <YearView />
      <HistoryPanel area="destino" />
    </div>
  );
}

type Key = string; // "company|varejo|ACTIVE" ou "seller|<id>|ACTIVE"
const keyOf = (scope: "company" | "seller", id: string, lvl: TargetLevel) =>
  `${scope}|${id}|${lvl}`;

function TargetsEditor({ data }: { data: TargetsMonth }) {
  const f = useFilters();
  const client = useQueryClient();
  const original = useMemo(() => {
    const m = new Map<Key, number | null>();
    for (const c of data.company)
      for (const l of LEVELS) m.set(keyOf("company", c.channel ?? "all", l), c.targets[l]);
    for (const s of data.sellers)
      for (const l of LEVELS) m.set(keyOf("seller", s.seller.id, l), s.targets[l]);
    return m;
  }, [data]);
  const [draft, setDraft] = useState<Map<Key, string>>(
    () => new Map([...original].map(([k, v]) => [k, formatInputMoney(v)])),
  );
  const [preview, setPreview] = useState<{ changes: TargetChange[]; result: TargetPreview } | null>(
    null,
  );

  const parsed = (k: Key) => parseMoneyInput(draft.get(k) ?? "");
  const value = (k: Key) => {
    const p = parsed(k);
    return p.ok ? p.value : (original.get(k) ?? null);
  };
  const changes: TargetChange[] = [];
  let invalid = 0;
  for (const [k, orig] of original) {
    const p = parsed(k);
    if (!p.ok) {
      invalid++;
      continue;
    }
    if (p.value !== orig) {
      const [scope, id, level] = k.split("|") as ["company" | "seller", string, TargetLevel];
      changes.push(
        scope === "company"
          ? { scope, channel: id === "all" ? null : (id as Channel), level, amount: p.value }
          : { scope, sellerId: id, level, amount: p.value },
      );
    }
  }
  const dirty = changes.length > 0;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const set = (k: Key, v: string) => setDraft((d) => new Map(d).set(k, v));
  const gridSellers = data.sellers.map((s) => ({
    id: s.seller.id,
    channel: s.seller.channel,
    editable: s.editable,
  }));

  function onPaste(e: ClipboardEvent<HTMLInputElement>, sellerId: string, col: number) {
    const block = parsePastedBlock(e.clipboardData.getData("text"));
    if (block.length <= 1 && (block[0]?.length ?? 0) <= 1) return;
    e.preventDefault();
    const plan = planPaste(gridSellers, sellerId, col, block, LEVELS);
    setDraft((d) => {
      const n = new Map(d);
      for (const c of plan.cells) n.set(keyOf("seller", c.sellerId, c.level), c.value);
      return n;
    });
    toast.info(
      `${plan.applied} linha(s) aplicada(s)${plan.ignored ? `, ${plan.ignored} ignorada(s)` : ""}. Revise e salve.`,
    );
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>, sellerId: string, col: number) {
    if (e.key === "Enter") {
      e.preventDefault();
      const next = nextEditable(gridSellers, sellerId, e.shiftKey ? -1 : 1);
      if (next) document.getElementById(`cell-${next}-${col}`)?.focus();
    }
  }
  function fillEmpty(source: "previous" | "suggestion") {
    setDraft((d) => {
      const n = new Map(d);
      for (const s of data.sellers)
        if (s.editable)
          for (const l of LEVELS) {
            const k = keyOf("seller", s.seller.id, l);
            if ((n.get(k) ?? "").trim()) continue;
            const v =
              source === "previous" ? s.previousMonth[l] : l === "ACTIVE" ? s.suggestion : null;
            if (v !== null) n.set(k, formatInputMoney(v));
          }
      return n;
    });
  }

  const previewM = useMutation({
    mutationFn: () => flightPlanApi.previewTargets(data.companyId, data.month, changes),
    onSuccess: (result) => setPreview({ changes, result }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });
  const saveM = useMutation({
    mutationFn: (ch: TargetChange[]) => flightPlanApi.saveTargets(data.companyId, data.month, ch),
    onSuccess: () => {
      toast.success("Metas salvas");
      setPreview(null);
      client.invalidateQueries({ queryKey: fpKey(f.persona) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });

  // Totais em tempo real (exibição do rascunho; o oficial vem da API após salvar).
  const companyTotal = (l: TargetLevel) => {
    const vals = data.company
      .map((c) => value(keyOf("company", c.channel ?? "all", l)))
      .filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const sellersTotal = (l: TargetLevel, ch?: Channel) =>
    data.sellers
      .filter((s) => !ch || s.seller.channel === ch)
      .reduce((a, s) => a + (value(keyOf("seller", s.seller.id, l)) ?? 0), 0);
  const companyOriginal = (l: TargetLevel) => {
    const vals = data.company
      .map((c) => original.get(keyOf("company", c.channel ?? "all", l)) ?? null)
      .filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const sellerDelta = (l: TargetLevel) =>
    data.sellers.reduce((a, s) => {
      const k = keyOf("seller", s.seller.id, l);
      return a + ((value(k) ?? 0) - (original.get(k) ?? 0));
    }, 0);
  const undOf = (l: TargetLevel) =>
    adjustedUndistributed(
      data.undistributed,
      l,
      companyOriginal(l),
      companyTotal(l),
      sellerDelta(l),
    ) ?? (companyTotal(l) === null ? null : companyTotal(l)! - sellersTotal(l));
  const und = undOf("ACTIVE");
  const planSource = usePlan().data?.targetSource;
  const anyEditable = data.canEditCompany || data.sellers.some((s) => s.editable);

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-lg font-semibold first-letter:uppercase">{monthLabel(data.month)}</p>
          <span className="rounded bg-accent px-2 py-1 text-xs font-semibold text-accent-foreground">
            Plano medido pela Meta {LEVEL_PT[data.activeLevel]}
          </span>
          <span className="text-sm text-muted-foreground">
            Meta do plano:{" "}
            {planSource === "company"
              ? "meta da empresa"
              : planSource === "sellers"
                ? "soma dos vendedores"
                : planSource === "none"
                  ? "sem meta"
                  : "…"}
          </span>
        </div>
        {data.readOnlyReason && (
          <p
            role="note"
            className="mt-3 rounded border border-warning/40 bg-warning/10 p-2 text-sm text-warning"
          >
            {data.readOnlyReason}
          </p>
        )}
      </Panel>

      <Panel title="Meta da empresa">
        <div className="grid gap-3 md:grid-cols-3">
          {data.company.map((c) => (
            <fieldset key={c.channel ?? "all"} className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-semibold">{CH_PT(c.channel)}</legend>
              {LEVELS.map((l) => {
                const k = keyOf("company", c.channel ?? "all", l),
                  p = parsed(k);
                return (
                  <label
                    key={l}
                    className="mt-2 grid grid-cols-[70px_1fr] items-center gap-2 text-sm"
                  >
                    {LEVEL_PT[l]}
                    <input
                      className="fp-num h-9 rounded border bg-background px-2 text-right disabled:opacity-70 aria-[invalid=true]:border-destructive"
                      aria-invalid={!p.ok}
                      aria-label={`Meta ${LEVEL_PT[l]} ${CH_PT(c.channel)}`}
                      disabled={!data.canEditCompany}
                      value={draft.get(k) ?? ""}
                      onChange={(e) => set(k, e.target.value)}
                      placeholder="Sem meta"
                    />
                  </label>
                );
              })}
            </fieldset>
          ))}
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="font-semibold">Total da empresa</p>
            {LEVELS.map((l) => (
              <p key={l} className="mt-2 flex justify-between">
                <span>{LEVEL_PT[l]}</span>
                <span className="fp-num">
                  {companyTotal(l) === null ? "Sem meta" : brl0(companyTotal(l))}
                </span>
              </p>
            ))}
          </div>
        </div>
      </Panel>

      <Panel
        title="Distribuição por vendedor"
        action={
          anyEditable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => fillEmpty("previous")}>
                Copiar do mês anterior
              </Button>
              <Button variant="outline" size="sm" onClick={() => fillEmpty("suggestion")}>
                Usar sugestão
              </Button>
            </div>
          )
        }
      >
        <p className="mb-2 text-xs text-muted-foreground">
          Cole um bloco do Excel a partir de qualquer célula. Enter desce para o próximo vendedor.
          Célula vazia remove a meta.
        </p>
        {data.sellers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum vendedor no seu escopo.</p>
        ) : (
          <TableWrap label="Grade de metas por vendedor">
            <thead>
              <tr>
                <th className={th}>Vendedor</th>
                {LEVELS.map((l) => (
                  <th key={l} className={thR}>
                    {LEVEL_PT[l]}
                  </th>
                ))}
                <th className={thR}>Mês anterior (Ativa)</th>
                <th className={thR}>Sugestão</th>
                <th className={th}>Aviso</th>
              </tr>
            </thead>
            {(["varejo", "licitacao"] as Channel[]).map((ch) => {
              const rows = displayOrder(
                data.sellers.map((s) => ({
                  s,
                  id: s.seller.id,
                  channel: s.seller.channel,
                  editable: s.editable,
                })),
              ).filter((x) => x.channel === ch);
              if (!rows.length) return null;
              return (
                <tbody key={ch}>
                  <tr>
                    <td colSpan={7} className="bg-secondary px-3 py-1.5 text-xs font-semibold">
                      {CH_PT(ch)} · Ativa {brl0(sellersTotal("ACTIVE", ch))}
                    </td>
                  </tr>
                  {rows.map(({ s }) => {
                    const v = (l: TargetLevel) => value(keyOf("seller", s.seller.id, l));
                    const warn =
                      (v("BASE") !== null && v("ACTIVE") !== null && v("BASE")! > v("ACTIVE")!) ||
                      (v("ACTIVE") !== null &&
                        v("CHALLENGE") !== null &&
                        v("ACTIVE")! > v("CHALLENGE")!);
                    return (
                      <tr key={s.seller.id}>
                        <td className={td}>
                          {s.seller.name}
                          {!s.seller.active && (
                            <span className="ml-1 text-xs text-muted-foreground">(inativo)</span>
                          )}
                        </td>
                        {LEVELS.map((l, col) => {
                          const k = keyOf("seller", s.seller.id, l),
                            p = parsed(k);
                          return (
                            <td key={l} className="border-t px-1 py-1">
                              <input
                                id={`cell-${s.seller.id}-${col}`}
                                className="fp-num h-8 w-28 rounded border bg-background px-2 text-right disabled:border-transparent disabled:bg-transparent aria-[invalid=true]:border-destructive"
                                aria-label={`${s.seller.name} meta ${LEVEL_PT[l]}`}
                                aria-invalid={!p.ok}
                                title={p.ok ? undefined : p.error}
                                disabled={!s.editable}
                                value={draft.get(k) ?? ""}
                                onChange={(e) => set(k, e.target.value)}
                                onPaste={(e) => onPaste(e, s.seller.id, col)}
                                onKeyDown={(e) => onKey(e, s.seller.id, col)}
                              />
                              {!p.ok && (
                                <span className="block text-[10px] text-destructive">
                                  {p.error}
                                </span>
                              )}
                            </td>
                          );
                        })}
                        <td className={tdR}>
                          {s.previousMonth.ACTIVE === null
                            ? "Sem meta"
                            : brl0(s.previousMonth.ACTIVE)}
                        </td>
                        <td className={tdR}>{brl0(s.suggestion)}</td>
                        <td className={td + " text-xs text-warning"}>
                          {warn ? "Base > Ativa ou Ativa > Desafio" : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
            <tfoot>
              <tr className="font-semibold">
                <td className={td}>Soma dos vendedores</td>
                {LEVELS.map((l) => (
                  <td key={l} className={tdR}>
                    {brl0(sellersTotal(l))}
                  </td>
                ))}
                <td colSpan={3} className={td} />
              </tr>
              <tr className={und ? "bg-warning/10 font-semibold text-warning" : ""}>
                <td className={td}>Não distribuído</td>
                {LEVELS.map((l) => {
                  const u = undOf(l);
                  return (
                    <td key={l} className={tdR}>
                      {u === null ? "—" : brl0(u)}
                    </td>
                  );
                })}
                <td colSpan={3} className={td}>
                  {und === null
                    ? "Sem meta da empresa"
                    : und > 0
                      ? `Faltam ${brl0(und)} para distribuir`
                      : und < 0
                        ? `Os vendedores somam ${brl0(-und)} a mais que a empresa`
                        : "Tudo distribuído"}
                </td>
              </tr>
            </tfoot>
          </TableWrap>
        )}
        {anyEditable && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              disabled={!dirty || invalid > 0 || previewM.isPending}
              onClick={() => previewM.mutate()}
            >
              {previewM.isPending ? "Preparando…" : "Salvar metas"}
            </Button>
            <span className="text-sm text-muted-foreground">
              {invalid > 0
                ? `${invalid} célula(s) inválida(s)`
                : dirty
                  ? `${changes.length} alteração(ões) não salvas`
                  : "Sem alterações"}
            </span>
          </div>
        )}
      </Panel>

      <AlertDialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <AlertDialogContent className="max-h-[85dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar lote de metas</AlertDialogTitle>
            <AlertDialogDescription>
              {preview &&
                `${preview.result.created} criadas, ${preview.result.updated} alteradas, ${preview.result.removed} removidas`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-1 text-sm">
            {preview?.result.rows.map((r, i) => (
              <li key={i} className="flex justify-between gap-2 border-b py-1">
                <span>
                  {r.label} · {LEVEL_PT[r.level]}
                </span>
                <span className="fp-num">
                  {brl0(r.before)} → {r.amount === null ? "removida" : brl0(r.amount)}
                </span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (preview) saveM.mutate(preview.changes);
              }}
              disabled={saveM.isPending}
            >
              {saveM.isPending ? "Gravando…" : "Confirmar e gravar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={blocker.status === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair sem salvar?</AlertDialogTitle>
            <AlertDialogDescription>
              Há {changes.length} alteração(ões) de meta não salvas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              Continuar editando
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>
              Sair e descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function YearView() {
  const f = useFilters();
  const year = Number(f.month.slice(0, 4));
  const months = usePeriodMonths(yearOf(f.month));
  const q = useQuery({
    queryKey: fpKey(f.persona, "year", f.company.id, year, f.search.canal),
    queryFn: () => flightPlanApi.getYear(f.company.id, year, f.search.canal),
  });
  return (
    <Panel title={`Visão do ano ${year}`}>
      {q.isPending ? (
        <Loading label="Carregando o ano…" />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <TableWrap label="Metas e realizado do ano">
          <thead>
            <tr>
              <th className={th}>Mês</th>
              <th className={thR}>Meta</th>
              <th className={thR}>Realizado</th>
              <th className={thR}>%</th>
              <th className={thR}>Meta acumulada</th>
              <th className={thR}>Realizado acumulado</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3].map((qi) => {
              const rows = q.data.slice(qi * 3, qi * 3 + 3);
              const pm = partialPeriod(
                rows.map((r) => ({
                  month: r.month,
                  target: r.target,
                  realized: r.realized,
                  workdaysRemaining:
                    months.data?.find((x) => x.month === r.month)?.workdaysRemaining ?? 0,
                })),
              );
              const warn = missingTargetLabel(pm);
              return [
                ...rows.map((r) => (
                  <tr key={r.month}>
                    <td className={td + " capitalize"}>{monthShort(r.month)}</td>
                    <td className={tdR}>{r.target === null ? "Sem meta" : brl0(r.target)}</td>
                    <td className={tdR}>{brl0(r.realized)}</td>
                    <td className={tdR}>{pct(r.attainment)}</td>
                    <td className={tdR}>{brl0(r.cumulativeTarget)}</td>
                    <td className={tdR}>{brl0(r.cumulativeRealized)}</td>
                  </tr>
                )),
                <tr key={`q${qi}`} className="bg-secondary font-semibold">
                  <td className={td}>
                    {qi + 1}º trimestre
                    {warn && <span className="block text-xs font-normal text-warning">{warn}</span>}
                  </td>
                  <td className={tdR}>{pm.target === null ? "Sem meta" : brl0(pm.target)}</td>
                  <td className={tdR}>
                    {brl0(pm.realizedTotal)}
                    <span className="block text-xs font-normal text-muted-foreground">
                      realizado total
                    </span>
                    {warn && pm.target !== null && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {brl0(pm.realizedWithTarget)} nos meses com meta
                      </span>
                    )}
                  </td>
                  <td className={tdR}>{pct(pm.attainment)}</td>
                  <td colSpan={2} className={td + " text-xs font-normal"}>
                    {pm.target === null
                      ? ""
                      : !months.data
                        ? "Ritmo para fechar a meta acumulada: calculando…"
                        : pm.requiredDailyPace === null
                          ? "Ritmo para fechar a meta acumulada: —"
                          : `Ritmo para fechar a meta acumulada: ${brl0(pm.requiredDailyPace)}/dia em ${workdaysLabel(pm.workdaysRemaining, f.company.saturdayWeight)}`}
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </TableWrap>
      )}
    </Panel>
  );
}
