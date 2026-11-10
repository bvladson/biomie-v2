/**
 * Admin › Assistente (IA): liga/desliga a chave ai_assistant e escolhe os perfis liberados
 * (plano da Fase 4: começa desligada e só com SUPER_ADMIN; liberação por etapas, cada uma com
 * aprovação). Mostra também o resumo de uso dos últimos 7 dias (só metadados; o texto das conversas
 * nunca é guardado).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { aiAdminGet, aiAdminSet } from "@/lib/ai.functions";
import { ROLE_LABELS, ROLES, type AppRole } from "@/domain/rbac";
import { useEffect, useState } from "react";

const SUMMARY_LABELS: [key: string, label: string][] = [
  ["total", "Pedidos"],
  ["ok", "Respondidos"],
  ["descartadas", "Descartados pela trava de números"],
  ["foraCatalogo", "Fora do catálogo"],
  ["falhas", "Falhas (IA ocupada, limite ou fora do ar)"],
  ["uteis", "Avaliados como úteis"],
  ["naoUteis", "Avaliados como não úteis"],
  ["tempoMedioMs", "Tempo médio de resposta (ms)"],
];

export function AssistantTab() {
  const getState = useServerFn(aiAdminGet);
  const setState = useServerFn(aiAdminSet);
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ["admin-ai-assistant"],
    queryFn: () => getState(),
  });
  const [enabled, setEnabled] = useState(false);
  const [roles, setRoles] = useState<string[]>(["SUPER_ADMIN"]);
  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setRoles(data.roles);
    }
  }, [data]);
  const mut = useMutation({
    mutationFn: () => setState({ data: { enabled, roles } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-ai-assistant"] });
      toast.success("Assistente atualizado");
    },
    onError: (e: Error) => toast.error(e.message.replace(/^ai::/, "")),
  });

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (error)
    return <p className="text-sm text-destructive">Não foi possível carregar: {error.message}</p>;

  const summary = (data?.summary ?? null) as Record<string, unknown> | null;
  const dirty = data && (enabled !== data.enabled || roles.join(",") !== data.roles.join(","));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Assistente (IA local MAG AI)</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          O BIOMIE calcula todos os números e conclusões; a IA local só escreve o texto. Toda
          resposta passa pela conferência de números, e o registro guarda apenas metadados — nunca a
          pergunta nem a resposta. Plano de liberação: SUPER_ADMIN (piloto) → ADMIN/GESTOR →
          VENDEDOR.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Switch id="ai-enabled" checked={enabled} onCheckedChange={setEnabled} />
        <Label htmlFor="ai-enabled" className="text-sm">
          {enabled ? "Assistente ligado" : "Assistente desligado"}
        </Label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Perfis que veem o balão</p>
        <div className="grid max-w-md grid-cols-2 gap-2">
          {ROLES.map((role: AppRole) => (
            <label key={role} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={roles.includes(role)}
                onCheckedChange={(v) =>
                  setRoles((prev) =>
                    v === true ? [...prev, role] : prev.filter((r) => r !== role),
                  )
                }
              />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
        {roles.length === 0 && (
          <p className="text-xs text-amber-600">Escolha pelo menos um perfil.</p>
        )}
      </div>

      <Button onClick={() => mut.mutate()} disabled={!dirty || roles.length === 0 || mut.isPending}>
        {mut.isPending ? "Salvando…" : "Salvar"}
      </Button>

      <div>
        <h3 className="text-sm font-semibold">Uso nos últimos 7 dias</h3>
        {summary ? (
          <dl className="mt-2 grid max-w-md grid-cols-2 gap-x-6 gap-y-1 text-sm">
            {SUMMARY_LABELS.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium">{String(summary[key] ?? 0)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Sem dados ainda.</p>
        )}
      </div>
    </div>
  );
}
