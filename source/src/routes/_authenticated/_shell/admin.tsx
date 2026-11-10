import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getFlightPlanSettings,
  listJobRuns,
  listAuditLog,
  listUsers,
  reprocessSnapshot,
  setActiveTargetLevel,
  setUserRole,
  setUserPermission,
} from "@/lib/admin.functions";
import {
  GRANTABLE_LABELS,
  GRANTABLE_PERMISSIONS,
  type GrantablePermission,
} from "@/domain/finance";
import { useState } from "react";
import { TeamsTab } from "@/components/admin/TeamsTab";
import { AssistantTab } from "@/components/admin/AssistantTab";
import { AdminNav } from "@/admin/components/AdminSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATUS_META, TARGET_LEVEL_LABELS, type TargetLevel } from "@/domain/flight-plan/config";
import { appContextQuery } from "@/lib/queries";
import { hasPermission, ROLE_LABELS, ROLES, type AppRole } from "@/domain/rbac";
import { METRIC_LIST } from "@/domain/metrics/registry";

export const Route = createFileRoute("/_authenticated/_shell/admin")({
  head: () => ({
    meta: [
      { title: "Administração — BIOMIE" },
      { name: "description", content: "Usuários, permissões e registro oficial de métricas." },
      { property: "og:title", content: "Administração — BIOMIE" },
      {
        property: "og:description",
        content: "Usuários, permissões e registro oficial de métricas.",
      },
    ],
  }),
  component: AdminPage,
});

function UsersTab() {
  const fetchUsers = useServerFn(listUsers);
  const setRole = useServerFn(setUserRole);
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchUsers(),
  });
  const mut = useMutation({
    mutationFn: (v: { userId: string; role: AppRole; enabled: boolean }) => setRole({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("Permissão atualizada");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const setPerm = useServerFn(setUserPermission);
  const permMut = useMutation({
    mutationFn: (v: { userId: string; permission: GrantablePermission; enabled: boolean }) =>
      setPerm({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("Permissão explícita atualizada");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (error) return <p className="p-6 text-sm text-muted-foreground">{error.message}</p>;
  if (isPending) return <Skeleton className="m-4 h-40" />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Usuário</TableHead>
            {ROLES.map((r) => (
              <TableHead key={r} className="text-center text-xs">
                {ROLE_LABELS[r]}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <div className="font-medium">{u.fullName ?? u.email}</div>
                <div className="text-xs text-muted-foreground">{u.email}</div>
              </TableCell>
              {ROLES.map((r) => (
                <TableCell key={r} className="text-center">
                  <Checkbox
                    checked={u.roles.includes(r)}
                    disabled={mut.isPending}
                    onCheckedChange={(v) =>
                      mut.mutate({ userId: u.id, role: r, enabled: v === true })
                    }
                    aria-label={`${ROLE_LABELS[r]} para ${u.email}`}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="border-t px-4 pb-1 pt-4">
        <h3 className="text-sm font-semibold">Permissões explícitas</h3>
        <p className="text-xs text-muted-foreground">
          Somam-se às permissões do papel. Ex.: Vendedor só vê inadimplência com
          &quot;Inadimplência&quot; marcada. Toda alteração fica na Auditoria.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Usuário</TableHead>
            {GRANTABLE_PERMISSIONS.map((p) => (
              <TableHead key={p} className="text-center text-xs">
                {GRANTABLE_LABELS[p]}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((u) => (
            <TableRow key={u.id}>
              <TableCell className="text-sm">{u.fullName ?? u.email}</TableCell>
              {GRANTABLE_PERMISSIONS.map((p) => (
                <TableCell key={p} className="text-center">
                  <Checkbox
                    checked={u.permissions.includes(p)}
                    disabled={permMut.isPending}
                    onCheckedChange={(v) =>
                      permMut.mutate({ userId: u.id, permission: p, enabled: v === true })
                    }
                    aria-label={`${GRANTABLE_LABELS[p]} para ${u.email}`}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MetricsTab() {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Métrica</TableHead>
            <TableHead>Fórmula</TableHead>
            <TableHead>Fonte</TableHead>
            <TableHead>Data</TableHead>
            <TableHead className="text-right">Versão</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {METRIC_LIST.map((m) => (
            <TableRow key={m.key} className="align-top">
              <TableCell className="max-w-xs">
                <div className="font-medium">{m.name}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{m.key}</div>
                <div className="mt-1 whitespace-normal text-xs text-muted-foreground">
                  {m.description}
                </div>
                {m.notes && (
                  <div className="mt-1 whitespace-normal text-[11px] text-muted-foreground/80">
                    Obs.: {m.notes}
                  </div>
                )}
              </TableCell>
              <TableCell className="max-w-sm whitespace-normal font-mono text-xs">
                {m.formula}
              </TableCell>
              <TableCell className="text-xs">{m.source}</TableCell>
              <TableCell className="text-xs">{m.dateDimension ?? "—"}</TableCell>
              <TableCell className="text-right text-xs tabular">v{m.version}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function FlightPlanTab() {
  const fetchSettings = useServerFn(getFlightPlanSettings);
  const save = useServerFn(setActiveTargetLevel);
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ["fp-settings"],
    queryFn: () => fetchSettings(),
  });
  const mut = useMutation({
    mutationFn: (level: TargetLevel) => save({ data: { level } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Referência do Plano de Voo atualizada");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (error) return <p className="p-6 text-sm text-muted-foreground">{error.message}</p>;
  if (isPending) return <Skeleton className="m-4 h-40" />;
  const c = data.config;
  return (
    <div className="grid gap-6 p-4 md:p-6 lg:grid-cols-3">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Meta de referência</h3>
        <p className="text-xs text-muted-foreground">
          Usada em todos os cálculos do Plano de Voo. Snapshots já salvos não são alterados.
        </p>
        <Select
          value={c.activeLevel}
          onValueChange={(v) => mut.mutate(v as TargetLevel)}
          disabled={mut.isPending}
        >
          <SelectTrigger className="w-56" aria-label="Meta de referência">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TARGET_LEVEL_LABELS) as TargetLevel[]).map((l) => (
              <SelectItem key={l} value={l}>
                {TARGET_LEVEL_LABELS[l]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Versão {data.version} · alterações registradas no log de auditoria.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Regras de status (realizado ÷ ideal)</h3>
        <ul className="text-sm">
          <li>
            {STATUS_META.ON_TRACK.symbol} {STATUS_META.ON_TRACK.label}: ≥ {pct(c.status.onTrack)}
          </li>
          <li>
            {STATUS_META.ATTENTION.symbol} {STATUS_META.ATTENTION.label}: ≥{" "}
            {pct(c.status.attention)} e &lt; {pct(c.status.onTrack)}
          </li>
          <li>
            {STATUS_META.RISK.symbol} {STATUS_META.RISK.label}: ≥ {pct(c.status.risk)} e &lt;{" "}
            {pct(c.status.attention)}
          </li>
          <li>
            {STATUS_META.CRITICAL.symbol} {STATUS_META.CRITICAL.label}: &lt; {pct(c.status.risk)}
          </li>
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Em mês encerrado, a razão é realizado ÷ meta. Valores configuráveis.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">
          Peso da carteira — REGRA PROVISÓRIA DO MODO DEMONSTRAÇÃO
        </h3>
        <ul className="text-sm">
          <li>
            0–{c.ageBuckets.freshMaxDays} dias → {pct(c.probableWeights.fresh)}
          </li>
          <li>
            {c.ageBuckets.freshMaxDays + 1}–{c.ageBuckets.recentMaxDays} dias →{" "}
            {pct(c.probableWeights.recent)}
          </li>
          <li>
            acima de {c.ageBuckets.recentMaxDays} dias → {pct(c.probableWeights.aged)}
          </li>
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Provisória para o modo demonstração. Com a integração Omie, o peso passará a considerar
          status, etapa e previsão de faturamento do pedido.
        </p>
      </div>
    </div>
  );
}

function JobsTab() {
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const fetchRuns = useServerFn(listJobRuns);
  const reprocess = useServerFn(reprocessSnapshot);
  const qc = useQueryClient();
  const [company, setCompany] = useState(ctx.companies[0]?.id ?? "");
  const [date, setDate] = useState(ctx.companies[0]?.dataAsOf ?? "");
  const { data, isPending } = useQuery({ queryKey: ["job-runs"], queryFn: () => fetchRuns() });
  const mut = useMutation({
    mutationFn: () => reprocess({ data: { company, date } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["job-runs"] });
      toast.success(`Snapshot reprocessado (${r.rows} linhas)`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="flex flex-col">
      <form
        className="flex flex-wrap items-end gap-3 border-b p-4"
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <Label>Empresa</Label>
          <Select value={company} onValueChange={setCompany}>
            <SelectTrigger className="w-60" aria-label="Empresa">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ctx.companies.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="snap-date">Data</Label>
          <Input
            id="snap-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="w-44"
          />
        </div>
        <Button type="submit" disabled={mut.isPending || !company || !date}>
          {mut.isPending ? "Reprocessando…" : "Reprocessar snapshot"}
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          Job diário automático. Reprocessar substitui o snapshot da empresa/data (sem duplicar).
        </p>
      </form>
      {isPending ? (
        <Skeleton className="m-4 h-32" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Início</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead>Erro</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs tabular">
                    {new Date(r.started_at).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.job_name}</TableCell>
                  <TableCell className="text-xs">
                    {r.trigger === "cron" ? "Agendado" : "Manual"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.status === "success"
                      ? "Sucesso"
                      : r.status === "failed"
                        ? "Falhou"
                        : "Executando"}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular">{r.rows_written}</TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                    {r.error ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {!data?.length && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    Nenhuma execução registrada.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AuditTab() {
  const fetchAudit = useServerFn(listAuditLog);
  const { data, isPending } = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: () => fetchAudit(),
  });
  if (isPending) return <Skeleton className="m-4 h-32" />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Data</TableHead>
            <TableHead>Usuário</TableHead>
            <TableHead>Ação</TableHead>
            <TableHead>Entidade</TableHead>
            <TableHead>Detalhes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(data ?? []).map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap text-xs tabular">
                {new Date(r.created_at).toLocaleString("pt-BR")}
              </TableCell>
              <TableCell className="text-xs">{r.actor}</TableCell>
              <TableCell className="font-mono text-xs">{r.action}</TableCell>
              <TableCell className="text-xs">{r.entity}</TableCell>
              <TableCell className="max-w-md truncate font-mono text-[11px] text-muted-foreground">
                {r.payload}
              </TableCell>
            </TableRow>
          ))}
          {!data?.length && (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                Nenhum registro de auditoria.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function MovedNotice({
  to,
  children,
}: {
  to: "/admin/usuarios" | "/admin/auditoria";
  children: React.ReactNode;
}) {
  return (
    <p className="border-b bg-accent/40 px-4 py-2.5 text-sm">
      {children}{" "}
      <Link to={to} className="font-medium text-primary underline-offset-2 hover:underline">
        Abrir
      </Link>
    </p>
  );
}

function AdminPage() {
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  if (!hasPermission(ctx.roles, "admin:manage")) {
    return (
      <main className="p-10 text-center text-sm text-muted-foreground">
        Acesso restrito a administradores.
      </main>
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <AdminNav />
      <h1 className="text-2xl font-semibold tracking-tight">Configurações do BI</h1>
      <Tabs defaultValue="users">
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            <TabsTrigger value="users">Usuários e permissões</TabsTrigger>
            <TabsTrigger value="metrics">Definições de métricas</TabsTrigger>
            <TabsTrigger value="flightplan">Plano de Voo</TabsTrigger>
            <TabsTrigger value="teams">Equipes</TabsTrigger>
            <TabsTrigger value="jobs">Jobs</TabsTrigger>
            <TabsTrigger value="assistant">Assistente (IA)</TabsTrigger>
            <TabsTrigger value="audit">Auditoria</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="users" className="panel mt-4">
          <MovedNotice to="/admin/usuarios">
            Para cadastrar pessoas, entregar o acesso, bloquear e definir empresas e vendedores, use
            Administração › Usuários.
          </MovedNotice>
          <UsersTab />
        </TabsContent>
        <TabsContent value="metrics" className="panel mt-4">
          <MetricsTab />
        </TabsContent>
        <TabsContent value="flightplan" className="panel mt-4">
          <FlightPlanTab />
        </TabsContent>
        <TabsContent value="teams" className="panel mt-4">
          <TeamsTab />
        </TabsContent>
        <TabsContent value="jobs" className="panel mt-4">
          <JobsTab />
        </TabsContent>
        <TabsContent value="assistant" className="panel mt-4">
          <AssistantTab />
        </TabsContent>
        <TabsContent value="audit" className="panel mt-4">
          <MovedNotice to="/admin/auditoria">
            A auditoria completa, com filtros e exportação, está em Administração › Auditoria.
          </MovedNotice>
          <AuditTab />
        </TabsContent>
      </Tabs>
    </main>
  );
}
