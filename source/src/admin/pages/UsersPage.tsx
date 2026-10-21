import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
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
import { adminApi } from "../api";
import type { AppRole, UserStatus } from "../api/contract";
import { ROLE_LABELS, ROLE_ORDER, STATUS_LABELS, relativeTime } from "../lib/rules";
import { EmptyState, ErrorState, Loading, PageHeader, useCompanies } from "../components/shared";
import { RoleBadges, StatusBadge } from "../components/users";

const PAGE = 25;
const ALL = "__all";

export function UsersPage() {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<string>(ALL);
  const [companyId, setCompanyId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [page, setPage] = useState(1);
  const companies = useCompanies();
  const filter = {
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(role !== ALL ? { role: role as AppRole } : {}),
    ...(companyId !== ALL ? { companyId } : {}),
    ...(status !== ALL ? { status: status as UserStatus } : {}),
    page,
    pageSize: PAGE,
  };
  const q = useQuery({
    queryKey: ["admin", "users", filter],
    queryFn: () => adminApi.listUsers(filter),
    placeholderData: keepPreviousData,
  });
  const cname = (id: string) => companies.data?.find((c) => c.id === id)?.name ?? "—";
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / PAGE));
  const reset =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      fn(v);
      setPage(1);
    };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Usuários"
        description="Quem acessa o BIOMIE, com quais papéis e em quais empresas."
        actions={
          <Button asChild>
            <Link to="/admin/usuarios/novo">
              <Plus className="size-4" aria-hidden /> Novo usuário
            </Link>
          </Button>
        }
      />
      <div className="grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Label htmlFor="u-search">Buscar</Label>
          <div className="relative mt-1">
            <Search
              className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="u-search"
              className="pl-8"
              placeholder="Nome, e-mail ou usuário"
              value={search}
              onChange={(e) => reset(setSearch)(e.target.value)}
            />
          </div>
        </div>
        <FilterSelect id="u-role" label="Papel" value={role} onChange={reset(setRole)}>
          {ROLE_ORDER.map((r) => (
            <SelectItem key={r} value={r}>
              {ROLE_LABELS[r]}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect id="u-co" label="Empresa" value={companyId} onChange={reset(setCompanyId)}>
          {(companies.data ?? []).map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect id="u-st" label="Status" value={status} onChange={reset(setStatus)}>
          {(Object.keys(STATUS_LABELS) as UserStatus[]).map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </FilterSelect>
      </div>

      <div className="rounded-lg border bg-card">
        {q.isLoading ? (
          <Loading rows={6} />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.rows.length ? (
          <EmptyState>Nenhum usuário encontrado com esses filtros.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <caption className="sr-only">Lista de usuários</caption>
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Nome e e-mail
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Papéis
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Empresas
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Vendedor
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Último acesso
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((u) => (
                  <tr key={u.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link
                        to="/admin/usuarios/$id"
                        params={{ id: u.id }}
                        className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {u.fullName}
                      </Link>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadges roles={u.roles} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {u.companyIds.slice(0, 2).map(cname).join(", ") || "—"}
                      {u.companyIds.length - 2 + u.otherCompanyCount > 0 && (
                        <span
                          className="ml-1 rounded bg-muted px-1.5 py-0.5"
                          title={[
                            ...u.companyIds.slice(2).map(cname),
                            ...(u.otherCompanyCount
                              ? [`${u.otherCompanyCount} fora do seu alcance`]
                              : []),
                          ].join(", ")}
                        >
                          +{Math.max(u.companyIds.length - 2, 0) + u.otherCompanyCount}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {u.sellerIds.length ? `${u.sellerIds.length} vinculado(s)` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <time dateTime={u.lastSignInAt ?? undefined}>
                        {relativeTime(u.lastSignInAt)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <nav aria-label="Paginação" className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {q.data?.total ?? 0} usuário(s) · página {page} de {pages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Próxima
          </Button>
        </div>
      </nav>
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="mt-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos</SelectItem>
          {children}
        </SelectContent>
      </Select>
    </div>
  );
}
