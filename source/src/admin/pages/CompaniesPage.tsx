import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { adminApi, type Company, type Holiday, type Me } from "../api";
import { MONTHS, monthWorkdays, parseHolidayList } from "../lib/workdays";
import {
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  WithReason,
  errMsg,
  isAdmin,
  isSuper,
  useCompanies,
  useMe,
} from "../components/shared";

const THIS_YEAR = new Date().getFullYear();
const YEARS = [THIS_YEAR - 1, THIS_YEAR, THIS_YEAR + 1];
const SCOPES: { value: Holiday["scope"]; label: string }[] = [
  { value: "national", label: "Nacionais" },
  { value: "state", label: "Estaduais (CE)" },
  { value: "city", label: "Municipais (Fortaleza)" },
  { value: "company", label: "Da empresa" },
];
const SOURCE_LABEL: Record<Company["dataSource"], string> = {
  DEMO: "Demonstração",
  OMIE_SHADOW: "Omie (espelho)",
  OMIE: "Omie",
};
const todayIso = () => new Date().toISOString().slice(0, 10);
const br = (iso: string) => iso.split("-").reverse().join("/");

// ---------------- Empresas ----------------
function CompaniesTable() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data, isPending, error, refetch } = useCompanies();
  const [editing, setEditing] = useState<Company | null>(null);
  const [name, setName] = useState("");
  const mut = useMutation({
    mutationFn: () => adminApi.renameCompany(editing!.id, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "companies"] });
      toast.success("Nome de exibição atualizado");
      setEditing(null);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (isPending) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!data.length) return <EmptyState>Nenhuma empresa disponível para você.</EmptyState>;
  const canRename = isSuper(me);
  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Nome de exibição</TableHead>
              <TableHead>Identificador</TableHead>
              <TableHead>Fonte de dados</TableHead>
              <TableHead className="text-right">Usuários com acesso</TableHead>
              <TableHead>
                <span className="sr-only">Ações</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="font-mono text-xs">{c.slug}</TableCell>
                <TableCell>
                  <div className="text-sm">{SOURCE_LABEL[c.dataSource]}</div>
                  <div className="text-xs text-muted-foreground">Configurada em Integrações</div>
                </TableCell>
                <TableCell className="text-right font-mono">{c.userCount}</TableCell>
                <TableCell className="text-right">
                  <WithReason
                    reason={canRename ? null : "Somente o Super admin edita o nome de exibição"}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canRename}
                      aria-label={`Editar nome de ${c.name}`}
                      onClick={() => {
                        setEditing(c);
                        setName(c.name);
                      }}
                    >
                      <Pencil className="size-4" /> <span className="hidden sm:inline">Editar</span>
                    </Button>
                  </WithReason>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nome de exibição</DialogTitle>
            <DialogDescription>
              O identificador ({editing?.slug}) e a fonte de dados não mudam.
            </DialogDescription>
          </DialogHeader>
          <form
            id="rename-form"
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              mut.mutate();
            }}
          >
            <Label htmlFor="company-name">Nome</Label>
            <Input id="company-name" value={name} onChange={(e) => setName(e.target.value)} />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              form="rename-form"
              disabled={name.trim().length < 2 || name.trim() === editing?.name || mut.isPending}
            >
              {mut.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------- Calendário ----------------
function editReason(
  me: Me | undefined,
  scope: Holiday["scope"],
  companyId: string | null,
): string | null {
  if (isSuper(me)) return null;
  if (!isAdmin(me)) return "Somente administradores editam feriados";
  if (scope !== "company")
    return "Feriados nacionais, estaduais e municipais são editados pelo Super admin";
  if (!companyId || !me?.companyIds.includes(companyId))
    return "Você só edita feriados das suas empresas";
  return null;
}

function HolidayDialog({
  open,
  onClose,
  initial,
  scope,
  companyId,
  year,
}: {
  open: boolean;
  onClose: () => void;
  initial: Holiday | null;
  scope: Holiday["scope"];
  companyId: string | null;
  year: number;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState(initial?.date ?? `${year}-01-01`);
  const [name, setName] = useState(initial?.name ?? "");
  const mut = useMutation({
    mutationFn: () =>
      adminApi.saveHoliday({
        ...(initial ? { id: initial.id } : {}),
        date,
        name,
        scope,
        companyId: scope === "company" ? companyId : null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "holidays"] });
      toast.success(initial ? "Feriado atualizado" : "Feriado adicionado");
      onClose();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Editar feriado" : "Adicionar feriado"}</DialogTitle>
          <DialogDescription>{SCOPES.find((s) => s.value === scope)?.label}</DialogDescription>
        </DialogHeader>
        <form
          id="holiday-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="h-date">Data</Label>
            <Input
              id="h-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="h-name">Nome</Label>
            <Input id="h-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="holiday-form"
            disabled={!date || !name.trim() || mut.isPending}
          >
            {mut.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onClose,
  existing,
  scope,
  companyId,
}: {
  open: boolean;
  onClose: () => void;
  existing: Holiday[];
  scope: Holiday["scope"];
  companyId: string | null;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const parsed = useMemo(
    () =>
      parseHolidayList(
        text,
        existing.map((h) => h.date),
      ),
    [text, existing],
  );
  const valid = parsed.filter((p) => !p.error && !p.duplicate);
  const dups = parsed.filter((p) => p.duplicate).length;
  const errors = parsed.filter((p) => p.error).length;
  const mut = useMutation({
    mutationFn: () =>
      adminApi.importHolidays(
        valid.map((p) => ({
          date: p.date!,
          name: p.name!,
          scope,
          companyId: scope === "company" ? companyId : null,
        })),
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["admin", "holidays"] });
      toast.success(
        `${r.created} feriado(s) importado(s)${r.duplicates ? `, ${r.duplicates} duplicado(s) ignorado(s)` : ""}`,
      );
      setText("");
      setPreview(false);
      onClose();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Importar feriados — {SCOPES.find((s) => s.value === scope)?.label}
          </DialogTitle>
          <DialogDescription>
            Cole uma linha por feriado no formato DD/MM/AAAA;Nome.
          </DialogDescription>
        </DialogHeader>
        {!preview ? (
          <div className="grid gap-1.5">
            <Label htmlFor="import-text">Lista de feriados</Label>
            <Textarea
              id="import-text"
              rows={8}
              className="font-mono text-sm"
              placeholder={"01/01/2027;Confraternização Universal\n21/04/2027;Tiradentes"}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm" aria-live="polite">
              <strong>{valid.length}</strong> a gravar · <strong>{dups}</strong> duplicado(s) ·{" "}
              <strong>{errors}</strong> com erro
            </p>
            {dups > 0 && (
              <p
                role="alert"
                className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm text-warning"
              >
                <AlertTriangle className="size-4" aria-hidden /> Duplicados não serão gravados.
              </p>
            )}
            <div className="max-h-72 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Linha</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Situação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed.map((p) => (
                    <TableRow key={p.line}>
                      <TableCell className="font-mono text-xs">{p.line}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.date ? br(p.date) : "—"}
                      </TableCell>
                      <TableCell className="text-sm">{p.name ?? p.raw}</TableCell>
                      <TableCell className="text-xs">
                        {p.error ? (
                          <span className="text-destructive">Erro: {p.error}</span>
                        ) : p.duplicate ? (
                          <span className="text-warning">Duplicado</span>
                        ) : (
                          <span className="text-success">Novo</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        <DialogFooter>
          {preview ? (
            <>
              <Button variant="outline" onClick={() => setPreview(false)}>
                Voltar e editar
              </Button>
              <Button disabled={!valid.length || mut.isPending} onClick={() => mut.mutate()}>
                {mut.isPending ? "Gravando…" : `Gravar ${valid.length} feriado(s)`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button disabled={!parsed.length} onClick={() => setPreview(true)}>
                Pré-visualizar
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Calendar() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const [year, setYear] = useState(THIS_YEAR);
  const [scope, setScope] = useState<Holiday["scope"]>("national");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; initial: Holiday | null }>({
    open: false,
    initial: null,
  });
  const [importOpen, setImportOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Holiday | null>(null);
  const company = companyId ?? companies?.[0]?.id ?? null;

  const q = useQuery({
    queryKey: ["admin", "holidays", year],
    queryFn: () => adminApi.listHolidays(year),
  });
  const next = useQuery({
    queryKey: ["admin", "holidays", year + 1],
    queryFn: () => adminApi.listHolidays(year + 1),
  });
  const del = useMutation({
    mutationFn: (id: string) => adminApi.deleteHoliday(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "holidays"] });
      toast.success("Feriado removido");
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const all = q.data ?? [];
  const forScope = all.filter(
    (h) => h.scope === scope && (scope !== "company" || h.companyId === company),
  );
  const forCount = all.filter((h) => h.scope !== "company" || h.companyId === company);
  const reason = editReason(me, scope, scope === "company" ? company : null);
  const nextYear = year + 1;
  const nextEmpty = next.isSuccess && next.data.length === 0;
  const today = todayIso();

  return (
    <div className="flex flex-col gap-4">
      {nextEmpty && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border-2 border-warning/60 bg-warning/10 p-4 text-sm text-warning"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p className="font-medium">
            {nextYear} sem feriados cadastrados: o cálculo de dias úteis vai contar esses dias como
            úteis.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cal-year">Ano</Label>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger id="cal-year" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cal-company">Empresa (feriados da empresa e dias úteis)</Label>
          <Select value={company ?? ""} onValueChange={setCompanyId}>
            <SelectTrigger id="cal-company" className="w-64 max-w-full">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              {(companies ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <section className="rounded-lg border bg-card" aria-labelledby="workdays-title">
        <div className="border-b p-4">
          <h3 id="workdays-title" className="text-sm font-semibold">
            Dias úteis restantes por mês — {year}
          </h3>
          <p className="text-xs text-muted-foreground">
            Segunda a sexta menos feriados. Este número alimenta o ritmo e o forecast do BIOMIE.
          </p>
        </div>
        {q.isPending ? (
          <Loading rows={2} />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <ul className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 lg:grid-cols-6">
            {MONTHS.map((m, i) => {
              const w = monthWorkdays(year, i, forCount, today);
              return (
                <li key={m} className="bg-card p-3">
                  <p className="text-xs text-muted-foreground">{m}</p>
                  <p className="font-mono text-lg font-semibold">
                    {w.remaining}
                    <span className="text-xs font-normal text-muted-foreground"> / {w.total}</span>
                  </p>
                  <p className="sr-only">
                    {w.remaining} dias úteis restantes de {w.total}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Tabs value={scope} onValueChange={(v) => setScope(v as Holiday["scope"])}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            {SCOPES.map((s) => (
              <TabsTrigger key={s.value} value={s.value}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={scope} className="mt-3 rounded-lg border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <WithReason reason={reason}>
              <Button
                size="sm"
                disabled={!!reason}
                onClick={() => setDialog({ open: true, initial: null })}
              >
                <Plus className="size-4" /> Adicionar
              </Button>
            </WithReason>
            <WithReason reason={reason}>
              <Button
                size="sm"
                variant="outline"
                disabled={!!reason}
                onClick={() => setImportOpen(true)}
              >
                <Upload className="size-4" /> Importar lista
              </Button>
            </WithReason>
            {reason && <span className="text-xs text-muted-foreground">{reason}.</span>}
          </div>
          {q.isPending ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : !forScope.length ? (
            <EmptyState>Nenhum feriado cadastrado nesta aba para {year}.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Data</TableHead>
                    <TableHead>Dia</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>
                      <span className="sr-only">Ações</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forScope.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell className="font-mono text-sm">{br(h.date)}</TableCell>
                      <TableCell className="text-sm capitalize">
                        {new Date(`${h.date}T12:00:00`).toLocaleDateString("pt-BR", {
                          weekday: "long",
                        })}
                      </TableCell>
                      <TableCell className="text-sm">{h.name}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {!reason && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Editar ${h.name}`}
                              onClick={() => setDialog({ open: true, initial: h })}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Remover ${h.name}`}
                              onClick={() => setToDelete(h)}
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {dialog.open && (
        <HolidayDialog
          open
          onClose={() => setDialog({ open: false, initial: null })}
          initial={dialog.initial}
          scope={scope}
          companyId={company}
          year={year}
        />
      )}
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        existing={forScope}
        scope={scope}
        companyId={company}
      />
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover feriado?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete &&
                `${br(toDelete.date)} — ${toDelete.name}. O dia passará a contar como útil.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => toDelete && del.mutate(toDelete.id)}>
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function CompaniesPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Empresas e calendário"
        description="Empresas do grupo e feriados usados no cálculo de dias úteis."
      />
      <section className="rounded-lg border bg-card" aria-labelledby="companies-title">
        <h2 id="companies-title" className="border-b p-4 text-base font-semibold">
          Empresas
        </h2>
        <CompaniesTable />
      </section>
      <section aria-labelledby="calendar-title" className="flex flex-col gap-3">
        <h2 id="calendar-title" className="text-base font-semibold">
          Calendário de feriados
        </h2>
        <Calendar />
      </section>
    </div>
  );
}
