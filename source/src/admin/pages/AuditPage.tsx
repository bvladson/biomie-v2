import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { adminApi, AUDIT_PAGE_SIZE as AUDIT_PAGE, type AuditEvent, type AuditFilter } from "../api";
import {
  AUDIT_ACTIONS,
  ENTITY_LABELS,
  describeChanges,
  sanitizePayload,
  toCsv,
} from "../lib/audit";
import {
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  errMsg,
  isAdmin,
  useCompanies,
  useMe,
} from "../components/shared";

const ANY = "__all";

export function AuditPage() {
  const { data: me, isPending: mePending } = useMe();
  const { data: companies } = useCompanies();
  const peopleQ = useQuery({
    queryKey: ["admin", "users", "audit-people"],
    queryFn: () => adminApi.listUsers({ pageSize: 500 }),
  });
  const people = (peopleQ.data?.rows ?? []).map((u) => ({ id: u.id, name: u.fullName }));
  const [filter, setFilter] = useState<AuditFilter>({ page: 1 });
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  const [exporting, setExporting] = useState(false);
  const allowed = isAdmin(me);
  const q = useQuery({
    queryKey: ["admin", "audit", filter],
    queryFn: () => adminApi.listAudit(filter),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  const companyName = (id: string) => companies?.find((c) => c.id === id)?.name ?? id;
  const personName = (id: string | null, fallback?: string) =>
    id ? (people.find((p) => p.id === id)?.name ?? fallback ?? "usuário fora do seu alcance") : "—";
  const set = (patch: { [K in keyof AuditFilter]?: AuditFilter[K] | undefined }) =>
    setFilter((f) => {
      const next: Record<string, unknown> = { ...f, ...patch, page: 1 };
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      return next as AuditFilter;
    });
  const page = filter.page ?? 1;
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / AUDIT_PAGE));

  async function exportCsv() {
    setExporting(true);
    try {
      const rows: AuditEvent[] = [];
      for (let p = 1; ; p++) {
        const r = await adminApi.listAudit({ ...filter, page: p });
        rows.push(...r.rows);
        if (rows.length >= r.total || !r.rows.length) break;
      }
      const csv = toCsv([
        ["Data", "Autor", "Ação", "Entidade", "Alvo", "Empresa", "Alterações"],
        ...rows.map((e) => [
          new Date(e.at).toLocaleString("pt-BR"),
          e.actorName,
          AUDIT_ACTIONS[e.action] ?? e.action,
          ENTITY_LABELS[e.entity] ?? e.entity,
          e.entity === "user" ? personName(e.entityId, e.targetName) : (e.entityId ?? ""),
          e.companyId ? companyName(e.companyId) : "",
          describeChanges(e, companyName)
            .map((c) => `${c.field}: ${c.before} → ${c.after}`)
            .join(" | "),
        ]),
      ]);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `auditoria-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${rows.length} evento(s) exportado(s)`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setExporting(false);
    }
  }

  if (mePending) return <Loading />;
  if (!allowed) return <EmptyState>Somente administradores acessam a auditoria.</EmptyState>;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Auditoria"
        description="Tudo o que foi alterado na administração. Senhas e links nunca aparecem."
        actions={
          <Button variant="outline" onClick={exportCsv} disabled={exporting || !q.data?.total}>
            <Download className="size-4" /> {exporting ? "Exportando…" : "Exportar CSV"}
          </Button>
        }
      />
      <fieldset className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
        <legend className="sr-only">Filtros</legend>
        <div className="grid gap-1.5">
          <Label htmlFor="f-from">De</Label>
          <Input
            id="f-from"
            type="date"
            value={filter.from ?? ""}
            onChange={(e) => set({ from: e.target.value || undefined })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="f-to">Até</Label>
          <Input
            id="f-to"
            type="date"
            value={filter.to ?? ""}
            onChange={(e) => set({ to: e.target.value || undefined })}
          />
        </div>
        <FilterSelect
          id="f-actor"
          label="Autor"
          value={filter.actorId}
          onChange={(v) => set({ actorId: v })}
          options={people.map((p) => [p.id, p.name])}
        />
        <FilterSelect
          id="f-action"
          label="Ação"
          value={filter.action}
          onChange={(v) => set({ action: v })}
          options={Object.entries(AUDIT_ACTIONS)}
        />
        <FilterSelect
          id="f-target"
          label="Alvo"
          value={filter.targetId}
          onChange={(v) => set({ targetId: v })}
          options={people.map((p) => [p.id, p.name])}
        />
        <FilterSelect
          id="f-company"
          label="Empresa"
          value={filter.companyId}
          onChange={(v) => set({ companyId: v })}
          options={(companies ?? []).map((c) => [c.id, c.name])}
        />
      </fieldset>

      <section className="rounded-lg border bg-card" aria-label="Eventos de auditoria">
        {q.isPending ? (
          <Loading rows={6} />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.rows.length ? (
          <EmptyState>Nenhum evento para os filtros escolhidos.</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Data</TableHead>
                    <TableHead>Autor</TableHead>
                    <TableHead>Ação</TableHead>
                    <TableHead>Alvo</TableHead>
                    <TableHead>Empresa</TableHead>
                    <TableHead>
                      <span className="sr-only">Detalhe</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {new Date(e.at).toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{e.actorName}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {AUDIT_ACTIONS[e.action] ?? e.action}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {ENTITY_LABELS[e.entity] ?? e.entity}:{" "}
                        {e.entity === "user"
                          ? personName(e.entityId, e.targetName)
                          : e.entity === "company" && e.entityId
                            ? companyName(e.entityId)
                            : (e.entityId ?? "lote")}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {e.companyId ? companyName(e.companyId) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDetail(e)}
                          aria-label={`Ver detalhe do evento ${e.id}`}
                        >
                          <Eye className="size-4" />{" "}
                          <span className="hidden sm:inline">Detalhe</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <nav
              aria-label="Paginação"
              className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-sm"
            >
              <span className="text-muted-foreground">
                {q.data.total} evento(s) · página {page} de {pages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setFilter((f) => ({ ...f, page: page - 1 }))}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pages}
                  onClick={() => setFilter((f) => ({ ...f, page: page + 1 }))}
                >
                  Próxima
                </Button>
              </div>
            </nav>
          </>
        )}
      </section>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{AUDIT_ACTIONS[detail.action] ?? detail.action}</DialogTitle>
                <DialogDescription>
                  {new Date(detail.at).toLocaleString("pt-BR")} · por {detail.actorName}
                  {detail.companyId && ` · ${companyName(detail.companyId)}`}
                </DialogDescription>
              </DialogHeader>
              {detail.action.startsWith("access.") && (
                <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                  O link ou a senha gerados nunca são registrados nem exibidos.
                </p>
              )}
              <ChangeTable e={detail} companyName={companyName} />
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="link" className="px-0">
                    Ver dados técnicos
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px]">
                    {JSON.stringify(
                      {
                        ...detail,
                        before: sanitizePayload(detail.before),
                        after: sanitizePayload(detail.after),
                      },
                      null,
                      2,
                    )}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChangeTable({ e, companyName }: { e: AuditEvent; companyName: (id: string) => string }) {
  const lines = describeChanges(e, companyName);
  if (!lines.length)
    return <p className="text-sm text-muted-foreground">Sem detalhes de alteração.</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Campo</TableHead>
            <TableHead>Antes</TableHead>
            <TableHead>Depois</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.field}>
              <TableCell className="text-sm font-medium">{l.field}</TableCell>
              <TableCell className="text-sm">{l.before}</TableCell>
              <TableCell className="text-sm">{l.after}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
  value?: string | undefined;
  onChange: (v?: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : v)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Todos</SelectItem>
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
