/** Peças pequenas da Inteligência do Estoque: estado, sinais, prioridade, card e dica dos gráficos. */
import type { ReactNode } from "react";
import {
  Archive,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Clock,
  Layers,
  OctagonAlert,
  Snail,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { IntelState } from "../api/intel-contract";
import { STATE_LABELS, STATE_TONE, flagLabel, type StateTone } from "../lib/intel";

const STATE_ICONS: Record<IntelState, LucideIcon> = {
  risco_ruptura: OctagonAlert,
  possivel_obsolescencia: Archive,
  sem_venda_janela: Clock,
  possivel_excesso: Layers,
  baixo_giro: Snail,
  historico_insuficiente: CircleHelp,
  novo: Sparkles,
  saudavel: CircleCheck,
  sem_saldo: CircleMinus,
};

/** Só o ícone leva a cor de alerta; o texto fica na cor de texto (contraste garantido). */
const TONE_ICON: Record<StateTone, string> = {
  critical: "text-destructive",
  serious: "text-risk",
  warning: "text-warning",
  good: "text-success",
  neutral: "text-muted-foreground",
};

export function StateBadge({ state, className }: { state: IntelState; className?: string }) {
  const Icon = STATE_ICONS[state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${className ?? ""}`}>
      <Icon aria-hidden className={`size-4 shrink-0 ${TONE_ICON[STATE_TONE[state]]}`} />
      <span>{STATE_LABELS[state]}</span>
    </span>
  );
}

export function FlagList({ flags, max = 3 }: { flags: string[]; max?: number }) {
  if (flags.length === 0) return null;
  const shown = flags.slice(0, max);
  const rest = flags.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((f) => (
        <Badge key={f} variant="outline" className="whitespace-nowrap font-normal text-foreground">
          {flagLabel(f)}
        </Badge>
      ))}
      {rest > 0 && (
        <Badge
          variant="outline"
          className="font-normal text-muted-foreground"
          title={flags.slice(max).map(flagLabel).join(", ")}
        >
          +{rest}
        </Badge>
      )}
    </div>
  );
}

/** Prioridade 0–100: número e uma régua fina (trilho claro do mesmo tom). */
export function PriorityMeter({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex min-w-24 items-center gap-2">
      <span className="w-9 text-right tabular-nums">{Math.round(pct)}</span>
      <span aria-hidden className="relative h-1.5 w-14 overflow-hidden rounded-full bg-primary/15">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/** Card de número; clicável quando abre a lista já filtrada. */
export function StatTile({
  label,
  value,
  foot,
  onSelect,
  active,
}: {
  label: string;
  value: string;
  foot?: ReactNode;
  onSelect?: (() => void) | undefined;
  active?: boolean | undefined;
}) {
  const body = (
    <>
      <span className="block text-sm text-muted-foreground">{label}</span>
      <span className="mt-2 block break-words text-2xl font-semibold">{value}</span>
      {foot && <span className="mt-1.5 block text-xs text-muted-foreground">{foot}</span>}
    </>
  );
  if (!onSelect) return <div className="panel p-4">{body}</div>;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active === true}
      className={`panel p-4 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "border-primary ring-1 ring-primary" : ""
      }`}
    >
      {body}
    </button>
  );
}

/** Dica dos gráficos: o valor vem primeiro e forte; o nome da série depois, com um traço da cor. */
export function TipBox({
  title,
  rows,
  note,
}: {
  title: ReactNode;
  rows: { key: string; label: string; value: string; color?: string | undefined }[];
  note?: ReactNode;
}) {
  return (
    <div className="grid min-w-44 max-w-72 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      <p className="font-medium">{title}</p>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          {r.color && (
            <span
              aria-hidden
              className="h-0.5 w-3 shrink-0 rounded"
              style={{ background: r.color }}
            />
          )}
          <span className="font-semibold tabular-nums">{r.value}</span>
          <span className="text-muted-foreground">{r.label}</span>
        </div>
      ))}
      {note && <p className="text-muted-foreground">{note}</p>}
    </div>
  );
}
