import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { myCompleteFirstPassword } from "@/lib/admin-users.functions";
import { passwordStrength } from "@/admin/lib/password";

export const Route = createFileRoute("/definir-senha")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Defina sua senha — BIOMIE" },
      { name: "description", content: "Troque a senha temporária no primeiro acesso ao BIOMIE." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DefinePassword,
});

/** Primeiro acesso com senha temporária: a troca é obrigatória antes de usar o sistema. */
function DefinePassword() {
  const navigate = useNavigate();
  const [state, setState] = useState<"checking" | "ready" | "expired">("checking");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      if (!user) return void navigate({ to: "/auth", replace: true });
      const meta = (user.app_metadata ?? {}) as Record<string, unknown>;
      if (!meta["must_change_password"]) return void navigate({ to: "/cockpit", replace: true });
      const expiresAt = meta["temp_password_expires_at"];
      setState(
        typeof expiresAt === "string" && Date.parse(expiresAt) < Date.now() ? "expired" : "ready",
      );
    });
  }, [navigate]);

  async function leave() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await myCompleteFirstPassword({ data: { next } });
      // Novo token já sem a marca de troca obrigatória.
      await supabase.auth.refreshSession();
      toast.success("Senha definida. Bem-vindo ao BIOMIE.");
      navigate({ to: "/cockpit", replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível definir a senha.");
    } finally {
      setSaving(false);
    }
  }

  const strength = passwordStrength(next);
  const valid = next.length >= 10 && next === confirm;

  if (state === "checking")
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">
        Carregando…
      </div>
    );
  if (state === "expired")
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-3">
          <h1 className="text-xl font-semibold">Senha temporária expirada</h1>
          <p className="text-sm text-muted-foreground">
            Peça ao administrador um novo acesso ao BIOMIE.
          </p>
          <Button variant="outline" onClick={() => void leave()}>
            Sair
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4" noValidate>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Defina sua senha</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Você entrou com uma senha temporária. Escolha a sua senha para continuar.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-pw">Nova senha</Label>
          <Input
            id="new-pw"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-describedby="new-pw-hint"
          />
          <p id="new-pw-hint" className="text-xs text-muted-foreground" aria-live="polite">
            Mínimo de 10 caracteres. Força: <span className="font-medium">{strength.label}</span>
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-pw-confirm">Confirmar nova senha</Label>
          <Input
            id="new-pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {confirm.length > 0 && confirm !== next && (
            <p className="text-xs text-destructive">As senhas não conferem.</p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!valid || saving}>
          {saving ? "Salvando…" : "Salvar e entrar"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => void leave()}>
          Sair
        </Button>
      </form>
    </div>
  );
}
