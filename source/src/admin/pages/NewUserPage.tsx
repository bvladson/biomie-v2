import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { adminApi } from "../api";
import type { AccessDelivery, AccessSecret, AdminUser } from "../api/contract";
import {
  accessErrors,
  companiesGrantable,
  EMAIL_RE,
  PERMISSION_LABELS,
  ROLE_LABELS,
  rolesGrantableOnCreate,
  usernameError,
} from "../lib/rules";
import { ErrorState, Loading, PageHeader, errMsg, useCompanies, useMe } from "../components/shared";
import { AccessEditor, SecretReveal, VisibilityBox, type AccessValue } from "../components/users";

const STEPS = ["Identificação", "Acesso", "Entrega do acesso", "Revisão"];

export function NewUserPage() {
  const me = useMe();
  const companies = useCompanies();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [access, setAccess] = useState<AccessValue>({
    roles: [],
    companyIds: [],
    defaultCompanyId: null,
    sellerIds: [],
    managedTeamIds: [],
    permissions: [],
  });
  const [delivery, setDelivery] = useState<AccessDelivery>("INVITE_LINK");
  const [touched, setTouched] = useState(false);
  const [done, setDone] = useState<{ user: AdminUser; secret: AccessSecret } | null>(null);

  const emailNorm = email.trim().toLowerCase();
  const existing = useQuery({
    queryKey: ["admin", "users", "email-check", emailNorm],
    queryFn: () => adminApi.listUsers({ search: emailNorm, pageSize: 50 }),
    enabled: EMAIL_RE.test(emailNorm),
    retry: 2,
  });
  const dupUser = existing.data?.rows.find((u) => u.email === emailNorm);
  const userTaken = useQuery({
    queryKey: ["admin", "users", "username-check", username],
    queryFn: () => adminApi.listUsers({ search: username, pageSize: 50 }),
    enabled: !!username && !usernameError(username),
    retry: 2,
  });
  const usernameDup = userTaken.data?.rows.some((u) => u.username === username);

  const create = useMutation({
    mutationFn: () =>
      adminApi.createUser({
        fullName: fullName.trim(),
        email: emailNorm,
        ...(username ? { username } : {}),
        roles: access.roles,
        companyIds: access.companyIds,
        defaultCompanyId: access.defaultCompanyId ?? "",
        sellerIds: access.sellerIds,
        managedTeamIds: access.managedTeamIds,
        permissions: access.permissions,
        delivery,
      }),
    onSuccess: (r) => {
      setDone(r);
      void qc.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  if (me.isLoading || companies.isLoading) return <Loading rows={6} />;
  if (me.error || companies.error)
    return <ErrorState error={me.error ?? companies.error} onRetry={() => location.reload()} />;
  const actor = me.data!;
  const allCompanies = companies.data!;
  const grantable = companiesGrantable(
    actor,
    allCompanies.map((c) => c.id),
  );

  if (done)
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        <PageHeader
          title="Usuário criado"
          description={`${done.user.fullName} foi cadastrado. Envie o acesso abaixo.`}
        />
        <div className="rounded-lg border bg-card p-5">
          <SecretReveal secret={done.secret} name={done.user.fullName} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => navigate({ to: "/admin/usuarios/$id", params: { id: done.user.id } })}
          >
            Concluir e ver o usuário
          </Button>
          <Button variant="outline" onClick={() => navigate({ to: "/admin/usuarios" })}>
            Voltar para a lista
          </Button>
        </div>
      </div>
    );

  const step1Errors = [
    fullName.trim().length < 3 && "Informe o nome completo.",
    !EMAIL_RE.test(emailNorm) && "Informe um e-mail válido.",
    dupUser && "E-mail já cadastrado.",
    usernameError(username),
    usernameDup && "Nome de usuário já em uso.",
  ].filter(Boolean) as string[];
  const step2Errors = accessErrors(access);
  const errors = step === 0 ? step1Errors : step === 1 ? step2Errors : [];
  const cname = (id: string) => allCompanies.find((c) => c.id === id)?.name ?? id;

  const next = () => {
    setTouched(true);
    if (errors.length) return;
    setTouched(false);
    setStep(step + 1);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHeader title="Novo usuário" description="Cadastro em 3 passos com revisão final." />
      <ol aria-label="Progresso" className="grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? "step" : undefined}
            className="flex flex-col gap-1 text-xs"
          >
            <span
              className={`h-1.5 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`}
              aria-hidden
            />
            <span
              className={i === step ? "font-semibold text-foreground" : "text-muted-foreground"}
            >
              {i < step && <Check className="mr-1 inline size-3" aria-hidden />}
              {i + 1}. <span className="hidden sm:inline">{s}</span>
              <span className="sr-only sm:hidden">{s}</span>
              {i < step && <span className="sr-only"> (concluído)</span>}
            </span>
          </li>
        ))}
      </ol>

      <form
        className="flex flex-col gap-5 rounded-lg border bg-card p-4 md:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (step < 3) next();
          else create.mutate();
        }}
        noValidate
      >
        <h2 className="text-lg font-semibold">{STEPS[step]}</h2>

        {step === 0 && (
          <div className="grid gap-4">
            <div>
              <Label htmlFor="nu-name">Nome completo</Label>
              <Input
                id="nu-name"
                className="mt-1"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="off"
                required
              />
            </div>
            <div>
              <Label htmlFor="nu-email">E-mail</Label>
              <Input
                id="nu-email"
                type="email"
                className="mt-1"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby="nu-email-hint"
                required
              />
              <div id="nu-email-hint" className="mt-1 text-xs" aria-live="polite">
                {dupUser ? (
                  <span className="text-destructive">
                    E-mail já cadastrado para{" "}
                    <Link
                      to="/admin/usuarios/$id"
                      params={{ id: dupUser.id }}
                      className="font-medium underline"
                    >
                      {dupUser.fullName}
                    </Link>
                    .
                  </span>
                ) : existing.isFetching ? (
                  <span className="text-muted-foreground">Verificando…</span>
                ) : null}
              </div>
            </div>
            <div>
              <Label htmlFor="nu-user">Nome de usuário (opcional)</Label>
              <Input
                id="nu-user"
                className="mt-1 font-mono"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                aria-describedby="nu-user-hint"
                maxLength={40}
              />
              <p id="nu-user-hint" className="mt-1 text-xs text-muted-foreground">
                Único, minúsculas, 3 a 40 caracteres: letras, números, ponto ou hífen.
              </p>
            </div>
          </div>
        )}

        {step === 1 && (
          <>
            <AccessEditor
              value={access}
              onChange={setAccess}
              companies={allCompanies}
              grantableCompanyIds={grantable}
              grantableRoles={rolesGrantableOnCreate(actor)}
            />
            <VisibilityBox
              value={access}
              companies={allCompanies}
              title="O que essa pessoa vai ver"
            />
          </>
        )}

        {step === 2 && (
          <RadioGroup
            value={delivery}
            onValueChange={(v) => setDelivery(v as AccessDelivery)}
            aria-label="Forma de entrega do acesso"
            className="grid gap-3"
          >
            <DeliveryOption
              id="d-link"
              value="INVITE_LINK"
              title="Link de convite (recomendado)"
              text="Uso único, vale 24 horas. A pessoa cria a própria senha."
            />
            <DeliveryOption
              id="d-pass"
              value="TEMP_PASSWORD"
              title="Senha temporária"
              text="Troca obrigatória no primeiro acesso."
            />
            <div className="flex items-start gap-3 rounded-md border border-dashed p-3 opacity-70">
              <RadioGroupItem value="EMAIL" id="d-email" disabled />
              <Label htmlFor="d-email" className="font-normal">
                <span className="block font-medium">Enviar por e-mail</span>
                <span className="text-xs text-muted-foreground">
                  Disponível quando o servidor de e-mail for configurado.
                </span>
              </Label>
            </div>
          </RadioGroup>
        )}

        {step === 3 && (
          <dl className="grid gap-3 text-sm sm:grid-cols-[180px_1fr]">
            <dt className="text-muted-foreground">Nome</dt>
            <dd>{fullName}</dd>
            <dt className="text-muted-foreground">E-mail</dt>
            <dd>{emailNorm}</dd>
            <dt className="text-muted-foreground">Nome de usuário</dt>
            <dd className="font-mono">{username || "—"}</dd>
            <dt className="text-muted-foreground">Papéis</dt>
            <dd>{access.roles.map((r) => ROLE_LABELS[r]).join(", ")}</dd>
            <dt className="text-muted-foreground">Empresas</dt>
            <dd>
              {access.companyIds.map(cname).join(", ")} (padrão:{" "}
              {access.defaultCompanyId ? cname(access.defaultCompanyId) : "—"})
            </dd>
            <dt className="text-muted-foreground">Permissões extras</dt>
            <dd>{access.permissions.map((p) => PERMISSION_LABELS[p]).join(", ") || "Nenhuma"}</dd>
            <dt className="text-muted-foreground">Entrega</dt>
            <dd>{delivery === "INVITE_LINK" ? "Link de convite (24 h)" : "Senha temporária"}</dd>
            <div className="sm:col-span-2">
              <VisibilityBox
                value={access}
                companies={allCompanies}
                title="O que essa pessoa vai ver"
              />
            </div>
          </dl>
        )}

        {touched && errors.length > 0 && (
          <ul
            role="alert"
            className="list-inside list-disc rounded-md border border-destructive/40 p-3 text-sm text-destructive"
          >
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {create.error && (
          <p role="alert" className="text-sm text-destructive">
            {errMsg(create.error)}
          </p>
        )}

        <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => (step === 0 ? navigate({ to: "/admin/usuarios" }) : setStep(step - 1))}
          >
            {step === 0 ? "Cancelar" : "Voltar"}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {step < 3 ? "Avançar" : create.isPending ? "Criando…" : "Confirmar e criar usuário"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function DeliveryOption({
  id,
  value,
  title,
  text,
}: {
  id: string;
  value: AccessDelivery;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary">
      <RadioGroupItem value={value} id={id} className="mt-0.5" />
      <Label htmlFor={id} className="cursor-pointer font-normal">
        <span className="block font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{text}</span>
      </Label>
    </div>
  );
}
