import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Laptop, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { adminApi } from "../api";
import { passwordStrength } from "../lib/password";
import { EmptyState, ErrorState, Loading, PageHeader, errMsg, useMe } from "../components/shared";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4 md:p-6" aria-labelledby={`sec-${title}`}>
      <h2 id={`sec-${title}`} className="text-base font-semibold">
        {title}
      </h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function NameForm() {
  const qc = useQueryClient();
  const { data: me, isPending, error, refetch } = useMe();
  const [name, setName] = useState("");
  useEffect(() => setName(me?.fullName ?? ""), [me?.fullName]);
  const mut = useMutation({
    mutationFn: () => adminApi.updateMyName(name),
    onSuccess: (m) => {
      qc.setQueryData(["admin", "me"], m);
      toast.success("Nome atualizado");
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (isPending) return <Loading rows={1} />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  const invalid = name.trim().length < 3;
  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) mut.mutate();
      }}
    >
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="my-name">Nome completo</Label>
        <Input
          id="my-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          aria-invalid={invalid}
          aria-describedby="my-name-hint"
        />
        <p id="my-name-hint" className="text-xs text-muted-foreground">
          Como seu nome aparece no BIOMIE e na auditoria.
        </p>
      </div>
      <Button type="submit" disabled={invalid || name.trim() === me.fullName || mut.isPending}>
        {mut.isPending ? "Salvando…" : "Salvar nome"}
      </Button>
    </form>
  );
}

const BAR = ["bg-destructive", "bg-destructive", "bg-warning", "bg-success", "bg-success"];

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const strength = passwordStrength(next);
  const tooShort = next.length > 0 && next.length < 10;
  const mismatch = confirm.length > 0 && confirm !== next;
  const mut = useMutation({
    mutationFn: () => adminApi.changeMyPassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Senha alterada. Os outros dispositivos foram desconectados.");
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const canSubmit = current && next.length >= 10 && next === confirm && !mut.isPending;
  return (
    <form
      className="grid max-w-md gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) mut.mutate();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="pw-current">Senha atual</Label>
        <Input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pw-next">Nova senha</Label>
        <Input
          id="pw-next"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-invalid={tooShort}
          aria-describedby="pw-next-hint pw-strength"
        />
        <div className="flex gap-1" aria-hidden>
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded ${strength.score >= i ? BAR[strength.score] : "bg-muted"}`}
            />
          ))}
        </div>
        <p id="pw-strength" className="text-xs text-muted-foreground" aria-live="polite">
          Força: <span className="font-medium text-foreground">{strength.label}</span>
        </p>
        <p
          id="pw-next-hint"
          className={`text-xs ${tooShort ? "text-destructive" : "text-muted-foreground"}`}
        >
          Mínimo de 10 caracteres. Misture maiúsculas, minúsculas, números e símbolos.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pw-confirm">Confirmar nova senha</Label>
        <Input
          id="pw-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={mismatch}
          aria-describedby="pw-confirm-hint"
        />
        {mismatch && (
          <p id="pw-confirm-hint" className="text-xs text-destructive">
            As senhas não conferem.
          </p>
        )}
      </div>
      <Button type="submit" className="justify-self-start" disabled={!canSubmit}>
        {mut.isPending ? "Alterando…" : "Alterar senha"}
      </Button>
    </form>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["admin", "my-sessions"],
    queryFn: () => adminApi.listMySessions(),
  });
  const mut = useMutation({
    mutationFn: () => adminApi.signOutOtherSessions(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "my-sessions"] });
      toast.success("Os outros dispositivos foram desconectados");
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (isPending) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!data.length) return <EmptyState>Nenhuma sessão ativa.</EmptyState>;
  const others = data.filter((s) => !s.current).length;
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y rounded-md border">
        {data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 p-3">
            <Laptop className="size-4 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {s.device}
                {s.current && (
                  <span className="ml-2 rounded bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                    Este dispositivo
                  </span>
                )}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {s.ip} · ativo em {new Date(s.lastActiveAt).toLocaleString("pt-BR")}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        className="self-start"
        disabled={!others || mut.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        <LogOut className="size-4" /> Sair dos outros dispositivos
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair dos outros dispositivos?</AlertDialogTitle>
            <AlertDialogDescription>
              {others}{" "}
              {others === 1 ? "dispositivo será desconectado" : "dispositivos serão desconectados"}.
              Este dispositivo continua conectado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => mut.mutate()}>Sair dos outros</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function MyAccountPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Minha conta"
        description="Seus dados de acesso. Disponível para qualquer usuário."
      />
      <Section title="Nome">
        <NameForm />
      </Section>
      <Section title="Senha" description="Depois de alterada, a senha nunca é exibida.">
        <PasswordForm />
      </Section>
      <Section title="Onde estou conectado">
        <Sessions />
      </Section>
    </div>
  );
}
