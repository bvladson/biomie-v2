import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SupplierOption } from "../api/contract";

/**
 * Filtro por fornecedor (0048), com busca pelo nome. O código do fornecedor é de cada conta do Omie, então
 * com "todas as empresas" o filtro fica desligado e explica por quê.
 */
export function SupplierPicker({
  options,
  value,
  onChange,
  needsCompany,
  loading,
}: {
  options: SupplierOption[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  needsCompany: boolean;
  loading?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value);
  const label = needsCompany
    ? "Escolha uma empresa"
    : current
      ? current.name
      : options.length === 0 && !loading
        ? "Sem fornecedores importados"
        : "Todos os fornecedores";
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground" id="filtro-fornecedor">
        Fornecedor
      </span>
      <div className="flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-labelledby="filtro-fornecedor"
              disabled={needsCompany || options.length === 0}
              className="h-11 w-64 max-w-full justify-between bg-card font-normal"
              title={
                needsCompany
                  ? "O código do fornecedor é de cada conta do Omie: escolha uma empresa."
                  : undefined
              }
            >
              <span className="truncate">{label}</span>
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
            <Command>
              <CommandInput placeholder="Buscar fornecedor…" />
              <CommandList>
                <CommandEmpty>Nenhum fornecedor com esse nome.</CommandEmpty>
                <CommandGroup>
                  {options.map((o) => (
                    <CommandItem
                      key={o.id}
                      value={`${o.name} ${o.id}`}
                      onSelect={() => {
                        onChange(o.id === value ? undefined : o.id);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={`size-4 ${o.id === value ? "opacity-100" : "opacity-0"}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">{o.name}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {o.products} {o.products === 1 ? "produto" : "produtos"}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {current && (
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="Tirar o filtro de fornecedor"
            onClick={() => onChange(undefined)}
          >
            <X className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
