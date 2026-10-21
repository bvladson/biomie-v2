import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Ban, KeyRound, Link2, LogOut, Trash2, UserCheck } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { adminApi } from "../api";
import type { AccessDelivery, AccessSecret, AdminUser, Company, Me } from "../api/contract";
import { AUDIT_ACTIONS, describeChanges } from "../lib/audit";
import {
  accessErrors,
  companiesGrantable,
  manageBlockReason,
  PERMISSION_LABELS,
  ROLE_LABELS,
  ROLE_ORDER,
  removesOwnAdmin,
  roleChangeBlockReason,
  selfActionReason,
  usernameError,
} from "../lib/rules";
import {
  EmptyState,
  ErrorState,
  Loading,
  WithReason,
  errMsg,
  useCompanies,
  useMe,
} from "../components/shared";
import {
  AccessEditor,
  RoleBadges,
  SecretReveal,
  StatusBadge,
  VisibilityBox,
  type AccessValue,
} from "../components/users";

type Change = { field: string; before: string; after: string };

export function UserDetailPage({ id }: { id: string }) {
  const me = useMe();
  const companies = useCompanies();
  const q = useQuery({ queryKey: ["admin", "user", id], queryFn: () => adminApi.getUser(id) });
  if (q.isLoading || me.isLoading || companies.isLoading) return <Loading rows={8} />;
  if (q.error || me.error || companies.error)
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <ErrorState error={q.error ?? me.error ?? companies.error} onRetry={() => q.refetch()} />
      </div>
    );
  const user = q.data!;
  const actor = me.data!;
  const lock = manageBlockReason(actor, user);
  return (
    <div className="flex flex-col gap-5">
      <BackLink />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{user.fullName}</h1>
          <StatusBadge status={user.status} />
        </div>
        <p className="text-sm text-muted-foreground">{user.email}</p>
        <RoleBadges roles={user.roles} />
        {user.status === "BLOCKED" && (
          <p
            role="status"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <strong className="text-destructive">Acesso bloqueado.</strong> Motivo:{" "}
            {user.blockedReason ?? "não informado"}
          </p>
        )}
        {lock && (
          <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
            Somente leitura: {lock}
          </p>
        )}
      </header>
      <Tabs defaultValue="perfil">
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="perfil">Perfil</TabsTrigger>
            <TabsTrigger value="acesso">Acesso</TabsTrigger>
            <TabsTrigger value="seguranca">Segurança</TabsTrigger>
            <TabsTrigger value="atividade">Atividade</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="perfil">
          <ProfileTab user={user} companies={companies.data!} lock={lock} />
        </TabsContent>
        <TabsContent value="acesso">
          <AccessTab user={user} actor={actor} companies={companies.data!} lock={lock} />
        </TabsContent>
        <TabsContent value="seguranca">
          <SecurityTab user={user} actor={actor} lock={lock} />
        </TabsContent>
        <TabsContent value="atividade">
          <ActivityTab user={user} companies={companies.data!} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/admin/usuarios"
      className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden /> Usuários
    </Link>
  );
}

function useRefresh(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["admin", "user", id] });
    void qc.invalidateQueries({ queryKey: ["admin", "users"] });
    void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
    void qc.invalidateQueries({ queryKey: ["admin", "sellers"] });
    void qc.invalidateQueries({ queryKey: ["admin", "companies"] });
  };
}

function ConfirmChanges({
  open,
  onOpenChange,
  changes,
  warning,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  changes: Change[];
  warning?: string | null;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirmar alterações</DialogTitle>
          <DialogDescription>Revise o que muda antes de gravar.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-2">
                  Campo
                </th>
                <th scope="col" className="py-1 pr-2">
                  Antes
                </th>
                <th scope="col" className="py-1">
                  Depois
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.field} className="border-t align-top">
                  <th scope="row" className="py-2 pr-2 text-left font-medium">
                    {c.field}
                  </th>
                  <td className="py-2 pr-2 text-muted-foreground line-through decoration-muted-foreground/50">
                    {c.before}
                  </td>
                  <td className="py-2">{c.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {warning && (
          <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            {warning}
          </p>
        )}
        {!!error && (
          <p role="alert" className="text-sm text-destructive">
            {errMsg(error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Gravando…" : "Confirmar e gravar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProfileTab({
  user,
  companies,
  lock,
}: {
  user: AdminUser;
  companies: Company[];
  lock: string | null;
}) {
  const [fullName, setFullName] = useState(user.fullName);
  const [username, setUsername] = useState(user.username ?? "");
  const [def, setDef] = useState(user.defaultCompanyId ?? "");
  const [open, setOpen] = useState(false);
  const refresh = useRefresh(user.id);
  useEffect(() => {
    setFullName(user.fullName);
    setUsername(user.username ?? "");
    setDef(user.defaultCompanyId ?? "");
  }, [user]);
  const cname = (id: string | null) => companies.find((c) => c.id === id)?.name ?? "—";
  const changes: Change[] = [];
  if (fullName.trim() !== user.fullName)
    changes.push({ field: "Nome", before: user.fullName, after: fullName.trim() });
  if ((username || null) !== user.username)
    changes.push({
      field: "Nome de usuário",
      before: user.username ?? "—",
      after: username || "—",
    });
  if (def && def !== user.defaultCompanyId)
    changes.push({
      field: "Empresa padrão",
      before: cname(user.defaultCompanyId),
      after: cname(def),
    });
  const uErr = usernameError(username);
  const m = useMutation({
    mutationFn: () =>
      adminApi.updateProfile(user.id, {
        fullName: fullName.trim(),
        username: username || null,
        ...(def ? { defaultCompanyId: def } : {}),
      }),
    onSuccess: () => {
      toast.success("Perfil atualizado.");
      setOpen(false);
      refresh();
    },
  });
  return (
    <form
      className="mt-4 grid max-w-xl gap-4 rounded-lg border bg-card p-4 md:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        m.reset();
        setOpen(true);
      }}
    >
      <fieldset disabled={!!lock} className="grid gap-4">
        <div>
          <Label htmlFor="p-name">Nome completo</Label>
          <Input
            id="p-name"
            className="mt-1"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="p-email">E-mail</Label>
          <Input id="p-email" className="mt-1" value={user.email} readOnly aria-readonly />
          <p className="mt-1 text-xs text-muted-foreground">O e-mail não pode ser alterado.</p>
        </div>
        <div>
          <Label htmlFor="p-user">Nome de usuário para login (opcional)</Label>
          <Input
            id="p-user"
            className="mt-1 font-mono"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            aria-invalid={!!uErr}
            aria-describedby="p-user-hint"
            maxLength={40}
          />
          <p
            id="p-user-hint"
            className={`mt-1 text-xs ${uErr ? "text-destructive" : "text-muted-foreground"}`}
          >
            {uErr ?? "Único, minúsculas: letras, números, ponto ou hífen."}
          </p>
          {user.legacyUsernames.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Também entra com {user.legacyUsernames.join(", ")} (do sistema antigo; continua
              valendo).
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="p-def">Empresa padrão</Label>
          <Select value={def} onValueChange={setDef}>
            <SelectTrigger id="p-def" className="mt-1">
              <SelectValue placeholder="Escolha" />
            </SelectTrigger>
            <SelectContent>
              {user.companyIds.map((c) => (
                <SelectItem key={c} value={c}>
                  {cname(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </fieldset>
      <div>
        <WithReason reason={lock}>
          <Button
            type="submit"
            disabled={!!lock || !changes.length || !!uErr || fullName.trim().length < 3}
          >
            Salvar perfil
          </Button>
        </WithReason>
      </div>
      <ConfirmChanges
        open={open}
        onOpenChange={setOpen}
        changes={changes}
        pending={m.isPending}
        error={m.error}
        onConfirm={() => m.mutate()}
      />
    </form>
  );
}

function AccessTab({
  user,
  actor,
  companies,
  lock,
}: {
  user: AdminUser;
  actor: Me;
  companies: Company[];
  lock: string | null;
}) {
  const initial = useMemo<AccessValue>(
    () => ({
      roles: user.roles,
      companyIds: user.companyIds,
      defaultCompanyId: user.defaultCompanyId,
      sellerIds: user.sellerIds,
      managedTeamIds: user.managedTeamIds,
      permissions: user.permissions,
    }),
    [user],
  );
  const [v, setV] = useState(initial);
  const [open, setOpen] = useState(false);
  const refresh = useRefresh(user.id);
  useEffect(() => setV(initial), [initial]);

  const roleLock = roleChangeBlockReason(actor);
  const grantable = companiesGrantable(
    actor,
    companies.map((c) => c.id),
  );
  // Empresas fora do alcance do Admin ficam visíveis mas travadas.
  const cname = (id: string) => companies.find((c) => c.id === id)?.name ?? id;
  const same = (a: unknown[], b: unknown[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const list = (a: string[], f: (x: string) => string) =>
    a.length ? a.map(f).join(", ") : "nenhum";
  const changes: Change[] = [];
  if (!same(v.roles, user.roles))
    changes.push({
      field: "Papéis",
      before: list(user.roles, (r) => ROLE_LABELS[r as never]),
      after: list(v.roles, (r) => ROLE_LABELS[r as never]),
    });
  if (!same(v.companyIds, user.companyIds))
    changes.push({
      field: "Empresas",
      before: list(user.companyIds, cname),
      after: list(v.companyIds, cname),
    });
  if (!same(v.sellerIds, user.sellerIds))
    changes.push({
      field: "Vendedores do Omie",
      before: `${user.sellerIds.length} vinculado(s)`,
      after: `${v.sellerIds.length} vinculado(s)`,
    });
  if (!same(v.managedTeamIds, user.managedTeamIds))
    changes.push({
      field: "Equipes que gerencia",
      before: `${user.managedTeamIds.length}`,
      after: `${v.managedTeamIds.length}`,
    });
  if (!same(v.permissions, user.permissions))
    changes.push({
      field: "Permissões extras",
      before: list(user.permissions, (p) => PERMISSION_LABELS[p as never]),
      after: list(v.permissions, (p) => PERMISSION_LABELS[p as never]),
    });

  const errs = accessErrors({ ...v, defaultCompanyId: v.defaultCompanyId });
  const selfAdmin = removesOwnAdmin(actor, user.id, v.roles);
  const lastRoleWarning =
    user.roles.length > 0 && v.roles.length === 0
      ? "Você está tirando o último papel desta pessoa. Ela deixará de ver qualquer dado do BIOMIE."
      : null;
  // Sem papel é permitido somente com confirmação explícita.
  const blocking = errs.filter(
    (e) => !(lastRoleWarning && e.startsWith("Escolha pelo menos um papel")),
  );

  const m = useMutation({
    // Tudo de uma vez no servidor: ou grava o conjunto inteiro, ou nada muda.
    mutationFn: () =>
      adminApi.updateAccess(user.id, {
        roles: v.roles,
        companyIds: v.companyIds,
        defaultCompanyId: v.defaultCompanyId,
        sellerIds: v.sellerIds,
        managedTeamIds: v.managedTeamIds,
        permissions: v.permissions,
      }),
    onSuccess: () => {
      toast.success("Acesso atualizado.");
      setOpen(false);
      refresh();
    },
    onError: () => refresh(),
  });

  const saveReason =
    lock ??
    (selfAdmin ? "Você não pode remover o próprio acesso de administrador." : null) ??
    (blocking[0] || null);

  return (
    <div className="mt-4 flex flex-col gap-5">
      <div className="rounded-lg border bg-card p-4 md:p-6">
        <fieldset disabled={!!lock}>
          <legend className="sr-only">Acesso</legend>
          <AccessEditor
            value={v}
            onChange={setV}
            companies={companies}
            grantableCompanyIds={grantable}
            grantableRoles={ROLE_ORDER}
            rolesLockedReason={roleLock}
            userId={user.id}
            otherCompanyCount={user.otherCompanyCount}
          />
        </fieldset>
      </div>
      <VisibilityBox value={v} companies={companies} />
      {blocking.length > 0 && changes.length > 0 && (
        <ul role="alert" className="list-inside list-disc text-sm text-destructive">
          {blocking.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <WithReason reason={changes.length ? saveReason : null}>
          <Button
            disabled={!!saveReason || !changes.length}
            onClick={() => {
              m.reset();
              setOpen(true);
            }}
          >
            Salvar acesso
          </Button>
        </WithReason>
        <Button variant="outline" disabled={!changes.length} onClick={() => setV(initial)}>
          Descartar
        </Button>
      </div>
      <ConfirmChanges
        open={open}
        onOpenChange={setOpen}
        changes={changes}
        warning={lastRoleWarning}
        pending={m.isPending}
        error={m.error}
        onConfirm={() => m.mutate()}
      />
    </div>
  );
}

function SecurityTab({ user, actor, lock }: { user: AdminUser; actor: Me; lock: string | null }) {
  const refresh = useRefresh(user.id);
  const navigate = useNavigate();
  const [secret, setSecret] = useState<AccessSecret | null>(null);
  const [dialog, setDialog] = useState<null | "block" | "unblock" | "signout" | "delete">(null);
  const [reason, setReason] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");

  const issue = useMutation({
    mutationFn: (d: AccessDelivery) => adminApi.issueAccess(user.id, d),
    onSuccess: (s) => {
      setSecret(s);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const block = useMutation({
    mutationFn: (blocked: boolean) => adminApi.setBlocked(user.id, blocked, reason),
    onSuccess: (u) => {
      toast.success(u.status === "BLOCKED" ? "Acesso bloqueado." : "Acesso reativado.");
      setDialog(null);
      refresh();
    },
  });
  const signout = useMutation({
    mutationFn: () => adminApi.signOutEverywhere(user.id),
    onSuccess: () => {
      toast.success("Sessões encerradas em todos os dispositivos.");
      setDialog(null);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: () => adminApi.deleteUser(user.id, confirmEmail),
    onSuccess: () => {
      toast.success("Usuário excluído. O histórico de auditoria foi mantido.");
      refresh();
      void navigate({ to: "/admin/usuarios" });
    },
  });

  const blocked = user.status === "BLOCKED";
  const blockReason = lock ?? selfActionReason(actor, user, "block");
  const deleteReason =
    (!actor.roles.includes("SUPER_ADMIN") ? "Somente o Super admin exclui usuários." : null) ??
    selfActionReason(actor, user, "delete");
  const open = (d: typeof dialog) => {
    setReason("");
    setConfirmEmail("");
    block.reset();
    signout.reset();
    del.reset();
    setDialog(d);
  };

  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <Card
        title="Novo acesso"
        text="Gera um link de uso único (24 h) ou uma senha temporária. Aparece uma única vez."
      >
        <div className="flex flex-wrap gap-2">
          <WithReason reason={lock ?? (blocked ? "Reative o usuário antes." : null)}>
            <Button
              disabled={!!lock || blocked || issue.isPending}
              onClick={() => issue.mutate("INVITE_LINK")}
            >
              <Link2 className="size-4" aria-hidden /> Gerar novo link de acesso
            </Button>
          </WithReason>
          <WithReason reason={lock ?? (blocked ? "Reative o usuário antes." : null)}>
            <Button
              variant="outline"
              disabled={!!lock || blocked || issue.isPending}
              onClick={() => issue.mutate("TEMP_PASSWORD")}
            >
              <KeyRound className="size-4" aria-hidden /> Gerar senha temporária
            </Button>
          </WithReason>
        </div>
      </Card>
      <Card
        title="Sessões"
        text="Desconecta a pessoa de todos os computadores e celulares. Uma tela já aberta para de funcionar em até 1 hora."
      >
        <WithReason reason={lock}>
          <Button variant="outline" disabled={!!lock} onClick={() => open("signout")}>
            <LogOut className="size-4" aria-hidden /> Encerrar sessões em todos os dispositivos
          </Button>
        </WithReason>
      </Card>
      <Card
        title={blocked ? "Reativar acesso" : "Bloquear acesso"}
        text={
          blocked
            ? "Devolve o acesso. Informe o motivo."
            : "Use quando a pessoa sair da empresa. O histórico é mantido."
        }
      >
        <WithReason reason={blockReason}>
          {blocked ? (
            <Button disabled={!!blockReason} onClick={() => open("unblock")}>
              <UserCheck className="size-4" aria-hidden /> Reativar
            </Button>
          ) : (
            <Button variant="destructive" disabled={!!blockReason} onClick={() => open("block")}>
              <Ban className="size-4" aria-hidden /> Bloquear acesso
            </Button>
          )}
        </WithReason>
      </Card>
      <Card
        title="Excluir usuário"
        text="Remove a conta definitivamente. Prefira bloquear. O histórico de auditoria é mantido."
      >
        <WithReason reason={deleteReason}>
          <Button variant="destructive" disabled={!!deleteReason} onClick={() => open("delete")}>
            <Trash2 className="size-4" aria-hidden /> Excluir usuário
          </Button>
        </WithReason>
      </Card>

      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {secret?.kind === "INVITE_LINK" ? "Novo link de acesso" : "Senha temporária"}
            </DialogTitle>
            <DialogDescription>Para {user.fullName}.</DialogDescription>
          </DialogHeader>
          {secret && <SecretReveal secret={secret} name={user.fullName} />}
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Já copiei, fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "block" || dialog === "unblock"}
        onOpenChange={(o) => !o && setDialog(null)}
      >
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              block.mutate(dialog === "block");
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>
                {dialog === "block" ? `Bloquear ${user.fullName}?` : `Reativar ${user.fullName}?`}
              </DialogTitle>
              <DialogDescription>
                {dialog === "block"
                  ? "A pessoa é desconectada e não consegue entrar até ser reativada. Uma tela já aberta para de funcionar em até 1 hora."
                  : "A pessoa volta a acessar com os mesmos papéis e empresas."}
              </DialogDescription>
            </DialogHeader>
            <div>
              <Label htmlFor="b-reason">Motivo (obrigatório)</Label>
              <Textarea
                id="b-reason"
                className="mt-1"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </div>
            {block.error && (
              <p role="alert" className="text-sm text-destructive">
                {errMsg(block.error)}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant={dialog === "block" ? "destructive" : "default"}
                disabled={reason.trim().length < 3 || block.isPending}
              >
                {dialog === "block" ? "Bloquear" : "Reativar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "signout"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Encerrar todas as sessões?</DialogTitle>
            <DialogDescription>
              {user.fullName} precisará entrar de novo em todos os dispositivos.
            </DialogDescription>
          </DialogHeader>
          {signout.error && (
            <p role="alert" className="text-sm text-destructive">
              {errMsg(signout.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button onClick={() => signout.mutate()} disabled={signout.isPending}>
              Encerrar sessões
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              del.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Excluir {user.fullName}?</DialogTitle>
              <DialogDescription>
                Esta ação não pode ser desfeita. O histórico de auditoria é mantido.
              </DialogDescription>
            </DialogHeader>
            <div>
              <Label htmlFor="d-email">
                Para confirmar, digite o e-mail <span className="font-mono">{user.email}</span>
              </Label>
              <Input
                id="d-email"
                className="mt-1"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                autoComplete="off"
              />
            </div>
            {del.error && (
              <p role="alert" className="text-sm text-destructive">
                {errMsg(del.error)}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={confirmEmail.trim().toLowerCase() !== user.email || del.isPending}
              >
                Excluir definitivamente
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Card({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
      {children}
    </section>
  );
}

function ActivityTab({ user, companies }: { user: AdminUser; companies: Company[] }) {
  const asTarget = useQuery({
    queryKey: ["admin", "audit", "target", user.id],
    queryFn: () => adminApi.listAudit({ targetId: user.id }),
  });
  const asActor = useQuery({
    queryKey: ["admin", "audit", "actor", user.id],
    queryFn: () => adminApi.listAudit({ actorId: user.id }),
  });
  if (asTarget.isLoading || asActor.isLoading) return <Loading rows={4} />;
  const err = asTarget.error ?? asActor.error;
  if (err)
    return (
      <ErrorState
        error={err}
        onRetry={() => {
          void asTarget.refetch();
          void asActor.refetch();
        }}
      />
    );
  const map = new Map<number, NonNullable<typeof asTarget.data>["rows"][number]>();
  for (const e of [...(asTarget.data?.rows ?? []), ...(asActor.data?.rows ?? [])]) map.set(e.id, e);
  const rows = [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
  const cname = (id: string) => companies.find((c) => c.id === id)?.name ?? id;
  if (!rows.length) return <EmptyState>Nenhuma atividade registrada para este usuário.</EmptyState>;
  return (
    <ol className="mt-4 flex flex-col gap-2">
      {rows.map((e) => (
        <li key={e.id} className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{AUDIT_ACTIONS[e.action] ?? e.action}</span>
            <time dateTime={e.at} className="text-xs text-muted-foreground">
              {new Date(e.at).toLocaleString("pt-BR")}
            </time>
          </div>
          <p className="text-xs text-muted-foreground">
            {e.actorId === user.id ? "Feito por esta pessoa" : `Por ${e.actorName}`}
            {e.companyId ? ` · ${cname(e.companyId)}` : ""}
          </p>
          <ul className="mt-1 text-xs">
            {describeChanges(e, cname).map((c) => (
              <li key={c.field}>
                <span className="text-muted-foreground">{c.field}:</span> {c.before} → {c.after}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
