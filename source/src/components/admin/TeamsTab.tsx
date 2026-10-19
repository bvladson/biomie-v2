import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { X } from "lucide-react";
import { listTeams, updateTeam, type TeamAction } from "@/lib/admin.functions";
import { useGlobalFilters } from "@/hooks/use-filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Action = TeamAction;

export function TeamsTab() {
  const { company } = useGlobalFilters();
  const companyId = company?.id;
  const fetchTeams = useServerFn(listTeams);
  const update = useServerFn(updateTeam);
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const { data, isPending, error } = useQuery({
    queryKey: ["admin-teams", companyId],
    queryFn: () => fetchTeams({ data: { company: companyId! } }),
    enabled: !!companyId,
  });
  const mut = useMutation({
    mutationFn: (a: Action) => update({ data: a }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-teams"] });
      qc.invalidateQueries();
      toast.success("Equipe atualizada");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (error) return <p className="p-6 text-sm text-muted-foreground">{error.message}</p>;
  if (isPending || !data) return <Skeleton className="m-4 h-40" />;
  const sellerName = (id: string) => data.sellers.find((s) => s.id === id)?.name ?? id;
  const userName = (id: string) => data.users.find((u) => u.id === id)?.label ?? id;
  const assigned = new Set(data.teams.flatMap((t) => t.members.map((m) => m.seller_id)));

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-muted-foreground">
        Empresa: <b className="text-foreground">{company?.name}</b>. Gestores veem somente
        vendedores, clientes, vendas, metas, carteira e produtos das suas equipes (regra aplicada no
        servidor). Mudanças de equipe encerram o vínculo anterior com data — o histórico não é
        apagado.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (companyId && newName.trim()) {
            mut.mutate({ type: "create", company: companyId, name: newName.trim() });
            setNewName("");
          }
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nova equipe"
          className="max-w-xs"
        />
        <Button type="submit" disabled={mut.isPending || newName.trim().length < 2}>
          Criar equipe
        </Button>
      </form>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.teams.map((t) => (
          <div key={t.id} className="rounded-md border p-4">
            <div className="flex items-center gap-2">
              <Input
                defaultValue={t.name}
                className="h-8 max-w-[240px] font-medium"
                aria-label="Nome da equipe"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== t.name) mut.mutate({ type: "rename", team: t.id, name: v });
                }}
              />
              {!t.active && <Badge variant="secondary">Inativa</Badge>}
              <div className="ml-auto flex items-center gap-2 text-xs">
                Ativa
                <Switch
                  checked={t.active}
                  onCheckedChange={(v) => mut.mutate({ type: "toggle", team: t.id, active: v })}
                />
              </div>
            </div>
            <div className="mt-3">
              <p className="eyebrow mb-1">Gestores</p>
              <div className="flex flex-wrap gap-1.5">
                {t.managers.map((m) => (
                  <Badge key={m.id} variant="outline" className="gap-1">
                    {userName(m.user_id)}
                    <button
                      aria-label="Remover gestor"
                      onClick={() =>
                        mut.mutate({ type: "removeManager", team: t.id, user: m.user_id })
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                {!t.managers.length && (
                  <span className="text-xs text-muted-foreground">Nenhum gestor</span>
                )}
              </div>
              <Select
                value=""
                onValueChange={(u) => mut.mutate({ type: "addManager", team: t.id, user: u })}
              >
                <SelectTrigger className="mt-2 h-8 w-[240px] text-xs">
                  <SelectValue placeholder="Atribuir gestor…" />
                </SelectTrigger>
                <SelectContent>
                  {data.users
                    .filter((u) => !t.managers.some((m) => m.user_id === u.id))
                    .map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                O usuário também precisa do papel Gestor.
              </p>
            </div>
            <div className="mt-3">
              <p className="eyebrow mb-1">Vendedores ({t.members.length})</p>
              <div className="flex flex-wrap gap-1.5">
                {t.members.map((m) => (
                  <Badge
                    key={m.id}
                    variant="secondary"
                    className="gap-1"
                    title={`desde ${m.valid_from}`}
                  >
                    {sellerName(m.seller_id)}
                    <button
                      aria-label="Remover vendedor"
                      onClick={() =>
                        mut.mutate({ type: "removeMember", team: t.id, seller: m.seller_id })
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <Select
                value=""
                onValueChange={(s) => mut.mutate({ type: "addMember", team: t.id, seller: s })}
              >
                <SelectTrigger className="mt-2 h-8 w-[240px] text-xs">
                  <SelectValue placeholder="Adicionar vendedor…" />
                </SelectTrigger>
                <SelectContent>
                  {data.sellers
                    .filter((s) => !t.members.some((m) => m.seller_id === s.id))
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                        {assigned.has(s.id) ? " (mover de outra equipe)" : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {t.history.length > 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Histórico:{" "}
                  {t.history
                    .map((h) => `${sellerName(h.seller_id)} (${h.valid_from} → ${h.valid_to})`)
                    .join(", ")}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
