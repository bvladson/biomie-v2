import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Nova senha — BIOMIE" },
      { name: "description", content: "Defina uma nova senha para sua conta BIOMIE." },
      { property: "og:title", content: "Nova senha — BIOMIE" },
      { property: "og:description", content: "Defina uma nova senha para sua conta BIOMIE." },
    ],
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<"checking" | "ready" | "invalid">("checking");

  useEffect(() => {
    // Recovery links put either a session or an error (expired/used) in the URL hash.
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get("error")) {
      setState("invalid");
      return;
    }
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setState("ready");
    });
    supabase.auth.getSession().then(({ data: d }) => {
      if (d.session) setState("ready");
      else setTimeout(() => setState((s) => (s === "checking" ? "invalid" : s)), 2500);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Senha atualizada");
    navigate({ to: "/cockpit", replace: true });
  }

  if (state !== "ready")
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-xl font-semibold">
            {state === "checking" ? "Validando link…" : "Link inválido ou expirado"}
          </h1>
          {state === "invalid" && (
            <p className="mt-2 text-sm text-muted-foreground">
              Links de recuperação valem uma única vez e expiram. Solicite um novo em{" "}
              <a href="/auth" className="underline">
                Entrar → Esqueceu a senha
              </a>
              .
            </p>
          )}
        </div>
      </div>
    );

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Definir nova senha</h1>
        <div className="grid gap-1.5">
          <Label htmlFor="pw">Nova senha</Label>
          <Input
            id="pw"
            type="password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={loading}>
          {loading ? "Salvando…" : "Salvar senha"}
        </Button>
      </form>
    </div>
  );
}
