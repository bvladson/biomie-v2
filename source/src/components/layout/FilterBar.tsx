import { useQuery } from "@tanstack/react-query";
import { Link2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGlobalFilters } from "@/hooks/use-filters";
import { filterOptionsQuery } from "@/lib/queries";
import { currentPeriod, shiftPeriod, parsePeriod, type GlobalFilters } from "@/domain/filters";
import { monthLabel } from "@/domain/format";

const ALL = "__all";

function FilterSelect({
  label,
  value,
  options,
  onChange,
  allLabel = "Todos",
  allowAll = true,
  width = "w-[150px]",
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (v: string | undefined) => void;
  allLabel?: string;
  allowAll?: boolean;
  width?: string;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger
        className={`${width.replace(/^w-/, "min-w-")} h-8 w-auto max-w-[300px] gap-1.5 bg-surface text-xs`}
        aria-label={label}
      >
        <span className="shrink-0 text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowAll && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FilterBar() {
  const { search, resolved, setFilters, clear, activeCount, companies, dataAsOf } =
    useGlobalFilters();
  const { data: opts } = useQuery({
    ...filterOptionsQuery(resolved?.company ?? ""),
    enabled: !!resolved?.company,
  });

  const base = dataAsOf ? dataAsOf.slice(0, 7) : currentPeriod();
  const periods = Array.from({ length: 24 }, (_, i) => {
    const p = shiftPeriod(base, -i);
    const { year, month } = parsePeriod(p);
    return { value: p, label: monthLabel(year, month) };
  });

  const set = (k: keyof GlobalFilters) => (v: string | undefined) => setFilters({ [k]: v });
  const cities = (opts?.cities ?? []).filter((c) => !search.state || c.state === search.state);

  async function copyLink() {
    const url = new URL(window.location.href);
    if (resolved) {
      url.searchParams.set("company", resolved.company);
      url.searchParams.set("period", resolved.period);
    }
    try {
      await navigator.clipboard.writeText(url.toString());
      toast.success("Link com filtros copiado");
    } catch {
      toast.error("Não foi possível copiar o link. Copie o endereço do navegador.");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect
        label="Empresa"
        value={resolved?.company}
        allowAll={false}
        width="w-[230px]"
        options={companies.map((c) => ({ value: c.id, label: c.name }))}
        onChange={(v) => v && setFilters({ company: v })}
      />
      <FilterSelect
        label="Período"
        value={resolved?.period}
        allowAll={false}
        width="w-[190px]"
        options={periods}
        onChange={(v) => v && setFilters({ period: v })}
      />
      <FilterSelect
        label="Canal"
        value={search.channel}
        options={(opts?.channels ?? []).map((c) => ({ value: c.id, label: c.name }))}
        onChange={set("channel")}
      />
      <FilterSelect
        label="Unidade"
        value={search.branch}
        allLabel="Todas"
        options={(opts?.branches ?? []).map((c) => ({ value: c.id, label: c.name }))}
        onChange={set("branch")}
      />
      <FilterSelect
        label="Vendedor"
        value={search.seller}
        width="w-[190px]"
        options={(opts?.sellers ?? []).map((c) => ({ value: c.id, label: c.name }))}
        onChange={set("seller")}
      />
      <FilterSelect
        label="Estado"
        value={search.state}
        width="w-[120px]"
        options={(opts?.states ?? []).map((s) => ({ value: s, label: s }))}
        onChange={set("state")}
      />
      <FilterSelect
        label="Cidade"
        value={search.city}
        allLabel="Todas"
        width="w-[170px]"
        options={cities.map((c) => ({ value: c.city, label: c.city }))}
        onChange={set("city")}
      />
      <FilterSelect
        label="Categoria"
        value={search.category}
        allLabel="Todas"
        width="w-[190px]"
        options={(opts?.categories ?? []).map((c) => ({ value: c, label: c }))}
        onChange={set("category")}
      />
      <div className="ml-auto flex items-center gap-1">
        {activeCount > 0 && (
          <Button variant="ghost" size="sm" onClick={clear} className="h-8 text-xs">
            <X className="size-3.5" /> Limpar ({activeCount})
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={copyLink} className="h-8 text-xs">
          <Link2 className="size-3.5" /> Copiar link
        </Button>
      </div>
    </div>
  );
}
