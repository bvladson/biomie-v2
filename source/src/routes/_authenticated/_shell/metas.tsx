import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useGlobalFilters } from "@/hooks/use-filters";
import { appContextQuery } from "@/lib/queries";
import { hasPermission } from "@/domain/rbac";
import { parsePeriod } from "@/domain/filters";
import { formatValue } from "@/domain/format";
import { TARGET_LEVEL_LABELS } from "@/domain/flight-plan/config";
import {
  applyPaste,
  buildChanges,
  cellKey,
  copyPrevious,
  initialDraft,
  levelWarnings,
  parseClipboard,
  TARGET_LEVELS,
  totals,
  type Draft,
} from "@/domain/targets/grid";
import { fetchTargetsGrid, saveTargets } from "@/lib/targets.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/_shell/metas")({
  head: () => ({
    meta: [
      { title: "Metas — BIOMIE" },
      {
        name: "description",
        content: "Metas mensais por vendedor: base, ativa e desafio, preenchidas em planilha.",
      },
    ],
  }),
  component: TargetsPage,
});

const MONTH_NAMES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function TargetsPage() {
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  if (!hasPermission(ctx.roles, "targets:manage")) {
    return (
      <main className="p-10 text-center text-sm text-muted-foreground">
        Acesso restrito a gestores e administradores.
      </main>
    );
  }
  return <TargetsEditor />;
}

function TargetsEditor() {
  const { resolved, companies } = useGlobalFilters();
  const q = resolved!;
  const { year, month } = parsePeriod(q.period);
  const company = companies.find((c) => c.id === q.company);
  const fetchGrid = useServerFn(fetchTargetsGrid);
  const save = useServerFn(saveTargets);
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ["targets-grid", q.company, year, month],
    queryFn: () => fetchGrid({ data: { company: q.company, year, month } }),
    // The grid holds unsaved typing: never refresh it behind the user's back.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [draft, setDraft] = useState<Draft>({});
  const loadedKey = useRef<string | null>(null);
  const dataKey = `${q.company}:${year}:${month}`;
  useEffect(() => {
    if (data && loadedKey.current !== dataKey) {
      setDraft(initialDraft(data.sellers));
      loadedKey.current = dataKey;
    }
  }, [data, dataKey]);

  const sellers = useMemo(() => data?.sellers ?? [], [data]);
  const { changes, errors } = useMemo(() => buildChanges(sellers, draft), [sellers, draft]);
  const errorByKey = useMemo(() => new Map(errors.map((e) => [e.key, e.message])), [errors]);
  const changedKeys = useMemo(
    () => new Set(changes.map((c) => cellKey(c.seller, c.level))),
    [changes],
  );
  const sum = useMemo(() => totals(sellers, draft), [sellers, draft]);
  const previousActive = sellers.reduce((acc, s) => acc + (s.previous.ACTIVE ?? 0), 0);
  const pending = changes.length + errors.length;

  const blocker = useBlocker({
    shouldBlockFn: () => pending > 0,
    enableBeforeUnload: () => pending > 0,
    withResolver: true,
  });

  const mutation = useMutation({
    mutationFn: () => save({ data: { company: q.company, year, month, rows: changes } }),
    onSuccess: async (result) => {
      toast.success(
        `Metas salvas: ${plural(result.saved, "valor gravado", "valores gravados")}` +
          (result.deleted ? `, ${plural(result.deleted, "removido", "removidos")}` : "") +
          ".",
      );
      loadedKey.current = null;
      // Cockpit, Plano de Voo and this grid read the new values right away.
      await qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const tableRef = useRef<HTMLTableElement>(null);
  const focusCell = (row: number, column: number, direction: 1 | -1) => {
    for (let r = row; r >= 0 && r < sellers.length; r += direction) {
      if (!sellers[r]!.editable) continue;
      const input = tableRef.current?.querySelector<HTMLInputElement>(
        `input[data-row="${r}"][data-col="${column}"]`,
      );
      input?.focus();
      return;
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, row: number, column: number) => {
    if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const up = e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey);
      focusCell(up ? row - 1 : row + 1, column, up ? -1 : 1);
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, row: number, column: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text)) return; // one value: the browser pastes it into the cell
    e.preventDefault();
    const result = applyPaste(sellers, draft, row, column, parseClipboard(text));
    setDraft(result.draft);
    toast.message(
      `${plural(result.applied, "célula colada", "células coladas")}` +
        (result.skipped
          ? `, ${plural(result.skipped, "ignorada", "ignoradas")} (somente leitura ou fora da tabela)`
          : "") +
        ".",
    );
  };
  const copyFromPrevious = () => {
    const result = copyPrevious(sellers, draft);
    setDraft(result.draft);
    toast.message(
      result.filled
        ? `${plural(result.filled, "célula preenchida", "células preenchidas")} com o mês anterior.`
        : "Nada a copiar: as células já têm valor ou o mês anterior não tem metas.",
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">{company?.name ?? "—"} · Metas mensais</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Metas — {MONTH_NAMES[month - 1]} de {year}
          </h1>
          {data && (
            <p className="mt-1 text-sm text-muted-foreground">
              Valores em R$ por vendedor. O Cockpit e o Plano de Voo usam a{" "}
              <span className="font-medium text-foreground">
                {TARGET_LEVEL_LABELS[data.activeLevel]}
              </span>
              .
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={copyFromPrevious}
            disabled={!data?.canEdit || mutation.isPending}
          >
            Copiar do mês anterior
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft(initialDraft(sellers))}
            disabled={pending === 0 || mutation.isPending}
          >
            Desfazer alterações
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={changes.length === 0 || errors.length > 0 || mutation.isPending}
          >
            {mutation.isPending
              ? "Salvando…"
              : changes.length
                ? `Salvar ${plural(changes.length, "alteração", "alterações")}`
                : "Salvar"}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="panel p-8 text-center text-sm text-muted-foreground">{error.message}</div>
      ) : isPending || !data ? (
        <Skeleton className="h-96" />
      ) : sellers.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted-foreground">
          Nenhum vendedor no seu escopo nesta empresa.
        </div>
      ) : (
        <>
          {!data.canEdit && (
            <p className="text-sm text-muted-foreground">
              Você pode ver estas metas, mas não alterá-las.
            </p>
          )}
          {errors.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {plural(errors.length, "célula com valor inválido", "células com valor inválido")}.
              Corrija para salvar.
            </p>
          )}
          <div className="panel overflow-x-auto">
            <table ref={tableRef} className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Vendedor</th>
                  {TARGET_LEVELS.map((level) => (
                    <th key={level} className="w-44 px-3 py-2 text-right font-medium">
                      {TARGET_LEVEL_LABELS[level]}
                      {level === data.activeLevel && (
                        <Badge variant="secondary" className="ml-2 normal-case">
                          Cockpit
                        </Badge>
                      )}
                    </th>
                  ))}
                  <th className="w-40 px-3 py-2 text-right font-medium">Ativa no mês anterior</th>
                  <th className="px-3 py-2 font-medium">Avisos</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((seller, row) => (
                  <tr key={seller.id} className="border-b last:border-0">
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{seller.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {seller.team ?? "Sem equipe"}
                        {!seller.active && " · inativo"}
                      </div>
                    </td>
                    {TARGET_LEVELS.map((level, column) => {
                      const key = cellKey(seller.id, level);
                      const message = errorByKey.get(key);
                      return (
                        <td key={level} className="px-2 py-1.5">
                          <input
                            data-row={row}
                            data-col={column}
                            aria-label={`${TARGET_LEVEL_LABELS[level]} de ${seller.name}`}
                            aria-invalid={message ? true : undefined}
                            title={message}
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="—"
                            className={cn(
                              "h-9 w-full rounded-md border border-input bg-background px-2 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted/40 disabled:text-muted-foreground",
                              changedKeys.has(key) && "border-primary bg-primary/5",
                              message && "border-destructive bg-destructive/5",
                            )}
                            value={draft[key] ?? ""}
                            disabled={!seller.editable || mutation.isPending}
                            onChange={(e) => {
                              const value = e.target.value;
                              setDraft((d) => ({ ...d, [key]: value }));
                            }}
                            onKeyDown={(e) => onKeyDown(e, row, column)}
                            onPaste={(e) => onPaste(e, row, column)}
                            onFocus={(e) => e.target.select()}
                          />
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {seller.previous.ACTIVE != null
                        ? formatValue(seller.previous.ACTIVE, "currency")
                        : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {levelWarnings(draft, seller.id).map((warning) => (
                          <Badge
                            key={warning}
                            variant="outline"
                            className="border-warning/50 text-warning"
                          >
                            {warning}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-medium">
                  <td className="px-3 py-2">Total</td>
                  {TARGET_LEVELS.map((level) => (
                    <td key={level} className="px-3 py-2 text-right tabular-nums">
                      {formatValue(sum[level], "currency")}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {formatValue(previousActive, "currency")}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Cole um bloco copiado do Excel a partir de qualquer célula: as colunas seguem a ordem
            Base, Ativa e Desafio. Enter desce para o próximo vendedor. Célula vazia remove a meta.
            Cada gravação fica registrada na auditoria e vale na hora para o Cockpit e o Plano de
            Voo.
          </p>
        </>
      )}

      <AlertDialog open={blocker.status === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair sem salvar?</AlertDialogTitle>
            <AlertDialogDescription>
              Há {plural(pending, "alteração não salva", "alterações não salvas")} nas metas de{" "}
              {MONTH_NAMES[month - 1]}. Se sair agora, elas serão descartadas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              Continuar editando
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>
              Sair sem salvar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
