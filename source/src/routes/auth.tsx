import { createFileRoute, useHydrated, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { BrandMark } from "@/components/brand/BrandMark";
import { signInWithIdentifier } from "@/lib/auth.functions";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Entrar — BIOMIE" },
      { name: "description", content: "Acesse a plataforma BIOMIE Analytics." },
      { property: "og:title", content: "Entrar — BIOMIE" },
      { property: "og:description", content: "Acesse a plataforma BIOMIE Analytics." },
    ],
  }),
  component: AuthPage,
});

type Mode = "signin" | "signup" | "forgot";

const googleEnabled = import.meta.env["VITE_GOOGLE_AUTH_ENABLED"] === "true";
const signupEnabled = import.meta.env["VITE_PUBLIC_SIGNUP_ENABLED"] === "true";
const recoveryEnabled = import.meta.env["VITE_PASSWORD_RECOVERY_ENABLED"] === "true";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  // Before hydration a native submit would reload the page (GET); keep the form
  // inert until React owns it.
  const hydrated = useHydrated();
  const busy = loading || !hydrated;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/cockpit", replace: true });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) navigate({ to: "/cockpit", replace: true });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signin") {
        const tokens = await signInWithIdentifier({ data: { identifier: email, password } });
        const { error } = await supabase.auth.setSession(tokens);
        if (error) throw error;
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin + "/cockpit",
            data: { full_name: name },
          },
        });
        if (error) throw error;
        toast.success("Conta criada. Confirme pelo link enviado ao seu e-mail.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success("Enviamos um link de recuperação para seu e-mail.");
        setMode("signin");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha na autenticação");
    } finally {
      setLoading(false);
    }
  }

  async function google() {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth` },
      });
      if (error) throw error;
    } catch {
      toast.error("Não foi possível entrar com Google");
    } finally {
      setLoading(false);
    }
  }

  const titles: Record<Mode, string> = {
    signin: "Entrar no BIOMIE",
    signup: "Criar conta",
    forgot: "Recuperar senha",
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between border-r border-sidebar-border bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-8" />
          <div className="leading-none">
            <div className="font-semibold tracking-tight text-white">BIOMIE</div>
            <div className="text-xs text-sidebar-foreground/70">Analytics Platform</div>
          </div>
        </div>
        <div className="max-w-md">
          <p className="text-3xl font-semibold leading-tight tracking-tight text-white">
            O que aconteceu, onde vamos chegar e o que fazer agora.
          </p>
          <p className="mt-4 text-sm text-sidebar-foreground/80">
            Faturamento, metas, carteira e forecast em uma única fonte oficial de métricas.
          </p>
        </div>
        <p className="text-xs text-sidebar-foreground/60">© BIOMIE</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form
          onSubmit={submit}
          method="post"
          action="#"
          aria-busy={busy}
          className="flex w-full max-w-sm flex-col gap-4"
        >
          <div className="mb-2 flex items-center gap-2 lg:hidden">
            <BrandMark className="size-7" />
            <span className="font-semibold">BIOMIE</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{titles[mode]}</h1>
          {mode === "signup" && (
            <div className="grid gap-1.5">
              <Label htmlFor="name">Nome</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="email">{mode === "signin" ? "E-mail ou usuário" : "E-mail"}</Label>
            <Input
              id="email"
              type={mode === "signin" ? "text" : "email"}
              autoComplete={mode === "signin" ? "username" : "email"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {mode !== "forgot" && (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Senha</Label>
                {mode === "signin" && recoveryEnabled && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setMode("forgot")}
                  >
                    Esqueceu a senha?
                  </button>
                )}
              </div>
              <Input
                id="password"
                type="password"
                minLength={mode === "signup" ? 8 : 1}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          )}
          <Button type="submit" disabled={busy}>
            {busy
              ? "Aguarde…"
              : mode === "signin"
                ? "Entrar"
                : mode === "signup"
                  ? "Criar conta"
                  : "Enviar link"}
          </Button>
          {mode !== "forgot" && googleEnabled && (
            <>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" /> ou{" "}
                <div className="h-px flex-1 bg-border" />
              </div>
              <Button type="button" variant="outline" onClick={google} disabled={busy}>
                Continuar com Google
              </Button>
            </>
          )}
          <p className="text-center text-sm text-muted-foreground">
            {mode === "signin" && signupEnabled ? (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setMode("signup")}
              >
                Não tem conta? Criar conta
              </button>
            ) : mode !== "signin" ? (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setMode("signin")}
              >
                Voltar para entrar
              </button>
            ) : (
              "Para obter acesso ou recuperar sua senha, procure o administrador."
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
