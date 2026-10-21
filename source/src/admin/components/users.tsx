import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Ban, Check, Clock, Copy, Eye, MailQuestion, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type {
  AccessSecret,
  AppRole,
  Company,
  GrantablePermission,
  UserStatus,
} from "../api/contract";
import {
  ALL_PERMISSIONS,
  describeVisibility,
  PERMISSION_LABELS,
  ROLE_HELP,
  ROLE_LABELS,
  ROLE_ORDER,
  STATUS_LABELS,
  whatsappText,
} from "../lib/rules";

const STATUS_ICON: Record<UserStatus, typeof Check> = {
  ACTIVE: UserCheck,
  BLOCKED: Ban,
  INVITED: MailQuestion,
  NEVER_SIGNED_IN: Clock,
};
const STATUS_CLS: Record<UserStatus, string> = {
  ACTIVE: "border-success/40 text-success",
  BLOCKED: "border-destructive/40 text-destructive",
  INVITED: "border-warning/40 text-warning",
  NEVER_SIGNED_IN: "border-border text-muted-foreground",
};

export function StatusBadge({ status }: { status: UserStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLS[status]}`}
    >
      <Icon className="size-3.5" aria-hidden /> {STATUS_LABELS[status]}
    </span>
  );
}

export function RoleBadges({ roles }: { roles: AppRole[] }) {
  if (!roles.length) return <span className="text-xs text-muted-foreground">Sem papel</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge key={r} variant="secondary" className="whitespace-nowrap font-normal">
          {ROLE_LABELS[r]}
        </Badge>
      ))}
    </div>
  );
}

export interface AccessValue {
  roles: AppRole[];
  companyIds: string[];
  defaultCompanyId: string | null;
  sellerIds: string[];
  managedTeamIds: string[];
  permissions: GrantablePermission[];
}

const toggle = <T,>(arr: T[], v: T, on: boolean) =>
  on ? Array.from(new Set([...arr, v])) : arr.filter((x) => x !== v);

export function VisibilityBox({
  value,
  companies,
  title = "O que essa pessoa vê",
}: {
  value: AccessValue;
  companies: Company[];
  title?: string;
}) {
  const name = (id: string) => companies.find((c) => c.id === id)?.name ?? id;
  return (
    <section
      aria-live="polite"
      className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm"
    >
      <h3 className="mb-1 flex items-center gap-2 font-semibold text-foreground">
        <Eye className="size-4" aria-hidden /> {title}
      </h3>
      <p className="text-foreground">
        {describeVisibility(value, name, value.managedTeamIds.length)}
      </p>
    </section>
  );
}

/** Editor de acesso compartilhado pelo assistente e pela aba Acesso. */
export function AccessEditor({
  value,
  onChange,
  companies,
  grantableCompanyIds,
  grantableRoles,
  rolesLockedReason,
  userId,
  otherCompanyCount = 0,
}: {
  value: AccessValue;
  onChange: (v: AccessValue) => void;
  companies: Company[];
  grantableCompanyIds: string[];
  grantableRoles: AppRole[];
  rolesLockedReason?: string | null;
  userId?: string;
  /** Empresas do usuário fora do alcance de quem edita: não aparecem e não mudam. */
  otherCompanyCount?: number;
}) {
  const set = (patch: Partial<AccessValue>) => onChange({ ...value, ...patch });
  const isSeller = value.roles.includes("VENDEDOR");
  const isManager = value.roles.includes("GESTOR");
  const selected = companies.filter((c) => value.companyIds.includes(c.id));

  const sellerQs = useQueries({
    queries: selected.map((c) => ({
      queryKey: ["admin", "sellers", c.id],
      queryFn: () => adminApi.listSellers(c.id),
      enabled: isSeller,
    })),
  });
  const teamQs = useQueries({
    queries: selected.map((c) => ({
      queryKey: ["admin", "teams", c.id],
      queryFn: () => adminApi.listTeams(c.id),
      enabled: isManager,
    })),
  });
  // Empresa de cada vendedor e equipe, a partir das listas carregadas (o servidor confere de novo).
  const sellerCompany = new Map<string, string>();
  for (const q of sellerQs) for (const s of q.data ?? []) sellerCompany.set(s.id, s.companyId);
  const teamCompany = new Map<string, string>();
  for (const q of teamQs) for (const t of q.data ?? []) teamCompany.set(t.id, t.companyId);
  const keepIn = (map: Map<string, string>, companyIds: string[]) => (id: string) => {
    const c = map.get(id);
    return !c || companyIds.includes(c);
  };

  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Papéis</legend>
        {rolesLockedReason ? (
          <div className="flex flex-col gap-2">
            <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
              {rolesLockedReason}
            </p>
            <RoleBadges roles={value.roles} />
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {ROLE_ORDER.filter((r) => grantableRoles.includes(r) || value.roles.includes(r)).map(
              (r) => {
                const id = `role-${r}`;
                const disabled = !grantableRoles.includes(r);
                return (
                  <label
                    key={r}
                    htmlFor={id}
                    className="flex cursor-pointer gap-3 rounded-md border bg-card p-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                  >
                    <Checkbox
                      id={id}
                      checked={value.roles.includes(r)}
                      disabled={disabled}
                      onCheckedChange={(c) => set({ roles: toggle(value.roles, r, c === true) })}
                    />
                    <span>
                      <span className="block text-sm font-medium">{ROLE_LABELS[r]}</span>
                      <span className="block text-xs text-muted-foreground">{ROLE_HELP[r]}</span>
                    </span>
                  </label>
                );
              },
            )}
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Empresas</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {companies.map((c) => {
            const id = `co-${c.id}`;
            const disabled = !grantableCompanyIds.includes(c.id);
            return (
              <label
                key={c.id}
                htmlFor={id}
                title={disabled ? "Você não acessa esta empresa." : undefined}
                className="flex cursor-pointer items-center gap-3 rounded-md border bg-card p-3 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
              >
                <Checkbox
                  id={id}
                  checked={value.companyIds.includes(c.id)}
                  disabled={disabled}
                  onCheckedChange={(on) => {
                    const companyIds = toggle(value.companyIds, c.id, on === true);
                    set({
                      companyIds,
                      defaultCompanyId:
                        value.defaultCompanyId && companyIds.includes(value.defaultCompanyId)
                          ? value.defaultCompanyId
                          : (companyIds[0] ?? null),
                      sellerIds: value.sellerIds.filter(keepIn(sellerCompany, companyIds)),
                      managedTeamIds: value.managedTeamIds.filter(keepIn(teamCompany, companyIds)),
                    });
                  }}
                />
                {c.name}
              </label>
            );
          })}
        </div>
        {otherCompanyCount > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Esta pessoa também acessa {otherCompanyCount}{" "}
            {otherCompanyCount === 1 ? "empresa fora" : "empresas fora"} do seu alcance. Esse acesso
            não muda aqui.
          </p>
        )}
        {selected.length > 0 && (
          <div className="mt-3 max-w-sm">
            <Label htmlFor="default-company">Empresa padrão</Label>
            <Select
              value={value.defaultCompanyId ?? ""}
              onValueChange={(v) => set({ defaultCompanyId: v })}
            >
              <SelectTrigger id="default-company" className="mt-1">
                <SelectValue placeholder="Escolha" />
              </SelectTrigger>
              <SelectContent>
                {selected.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </fieldset>

      {isSeller && (
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Vendedor do Omie por empresa</legend>
          <p className="mb-2 text-xs text-muted-foreground">
            Obrigatório para o papel Vendedor. Lista só vendedores ativos ainda sem login.
          </p>
          {!selected.length && (
            <p className="text-sm text-muted-foreground">Escolha uma empresa primeiro.</p>
          )}
          <div className="flex flex-col gap-3">
            {selected.map((c, i) => (
              <SellerPicker
                key={c.id}
                company={c}
                loading={sellerQs[i]?.isLoading ?? false}
                error={sellerQs[i]?.error}
                options={(sellerQs[i]?.data ?? []).filter(
                  (s) => s.active && (!s.userId || s.userId === userId),
                )}
                value={value.sellerIds.find((s) => sellerCompany.get(s) === c.id) ?? ""}
                onChange={(sid) =>
                  set({
                    sellerIds: [
                      ...value.sellerIds.filter((s) => sellerCompany.get(s) !== c.id),
                      ...(sid ? [sid] : []),
                    ],
                  })
                }
              />
            ))}
          </div>
        </fieldset>
      )}

      {isManager && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Equipes que gerencia</legend>
          {selected.map((c, i) => (
            <div key={c.id} className="mb-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">{c.name}</p>
              {teamQs[i]?.isLoading ? (
                <p className="text-xs text-muted-foreground">Carregando equipes…</p>
              ) : teamQs[i]?.error ? (
                <p className="text-xs text-destructive">Não foi possível carregar as equipes.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(teamQs[i]?.data ?? []).map((t) => (
                    <label
                      key={t.id}
                      htmlFor={`tm-${t.id}`}
                      className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm"
                    >
                      <Checkbox
                        id={`tm-${t.id}`}
                        checked={value.managedTeamIds.includes(t.id)}
                        onCheckedChange={(on) =>
                          set({ managedTeamIds: toggle(value.managedTeamIds, t.id, on === true) })
                        }
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </fieldset>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Permissões extras</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ALL_PERMISSIONS.map((p) => (
            <label
              key={p}
              htmlFor={`perm-${p}`}
              className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm"
            >
              <Checkbox
                id={`perm-${p}`}
                checked={value.permissions.includes(p)}
                onCheckedChange={(on) =>
                  set({ permissions: toggle(value.permissions, p, on === true) })
                }
              />
              {PERMISSION_LABELS[p]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function SellerPicker({
  company,
  options,
  value,
  onChange,
  loading,
  error,
}: {
  company: Company;
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
  error: unknown;
}) {
  const [q, setQ] = useState("");
  const list = options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  const sid = `seller-${company.id}`;
  return (
    <div className="grid gap-2 rounded-md border bg-card p-3 sm:grid-cols-2">
      <div>
        <Label htmlFor={`${sid}-q`}>Buscar vendedor — {company.name}</Label>
        <Input
          id={`${sid}-q`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nome do vendedor"
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor={sid}>Vendedor vinculado</Label>
        <Select value={value || "__none"} onValueChange={(v) => onChange(v === "__none" ? "" : v)}>
          <SelectTrigger id={sid} className="mt-1" disabled={loading || !!error}>
            <SelectValue placeholder={loading ? "Carregando…" : "Escolha"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none">Nenhum</SelectItem>
            {list.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!!error && (
          <p className="mt-1 text-xs text-destructive">Não foi possível carregar os vendedores.</p>
        )}
      </div>
    </div>
  );
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copiado.`);
  } catch {
    toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
  }
}

/** Exibe link/senha UMA única vez. O segredo vive só no estado do componente pai. */
export function SecretReveal({ secret, name }: { secret: AccessSecret; name: string }) {
  const isLink = secret.kind === "INVITE_LINK";
  const msg = whatsappText(name.split(" ")[0] ?? name, secret.value, secret.expiresAt, secret.kind);
  return (
    <div className="flex flex-col gap-4">
      <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
        <strong>Atenção:</strong> {isLink ? "este link" : "esta senha"} aparece só agora. Ao sair
        desta tela não será possível vê-lo de novo — será preciso gerar outro.
      </div>
      <div>
        <Label htmlFor="secret-value">
          {isLink ? "Link de convite (uso único)" : "Senha temporária (troca no 1º acesso)"}
        </Label>
        <div className="mt-1 flex gap-2">
          <Input id="secret-value" readOnly value={secret.value} className="font-mono" />
          <Button type="button" onClick={() => copy(secret.value, isLink ? "Link" : "Senha")}>
            <Copy className="size-4" aria-hidden /> Copiar
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Vale até {new Date(secret.expiresAt).toLocaleString("pt-BR")}.
        </p>
      </div>
      <div>
        <Label htmlFor="secret-wa">Texto pronto para WhatsApp</Label>
        <textarea
          id="secret-wa"
          readOnly
          value={msg}
          rows={3}
          className="mt-1 w-full rounded-md border bg-card p-2 text-sm"
        />
        <Button type="button" variant="outline" className="mt-2" onClick={() => copy(msg, "Texto")}>
          <Copy className="size-4" aria-hidden /> Copiar texto
        </Button>
      </div>
    </div>
  );
}
