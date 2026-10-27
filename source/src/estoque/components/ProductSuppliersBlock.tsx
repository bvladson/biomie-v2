import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { suppliersApi } from "../api/suppliers";
import { dateTime, errorMessage, quantity } from "../lib/format";
import {
  LeadTimeDialog,
  NoteActionDialog,
  type LeadTimeTarget,
  type NoteAction,
} from "./SupplierDialogs";

/**
 * Fornecedores do produto na empresa (0048): prazo de entrega de cada um (do produto ou o padrão dele) e o
 * fornecedor principal. Compras e o Super admin alteram daqui mesmo; os demais só consultam.
 */
export function ProductSuppliersBlock({
  companyId,
  omieProductId,
  productName,
}: {
  companyId: string;
  omieProductId: string;
  productName: string | null;
}) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["stock", "suppliers", "product", companyId, omieProductId],
    queryFn: () => suppliersApi.ofProduct(companyId, omieProductId),
    retry: false,
  });
  const [lead, setLead] = useState<LeadTimeTarget | null>(null);
  const [action, setAction] = useState<NoteAction | null>(null);
  const reload = () => void client.invalidateQueries({ queryKey: ["stock", "suppliers"] });
  if (q.isPending) return <p className="text-sm text-muted-foreground">Carregando fornecedores…</p>;
  if (q.error) return <p className="text-sm">{errorMessage(q.error)}</p>;
  const d = q.data;
  if (!d) return null;
  return (
    <div className="space-y-2">
      {d.suppliers.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm">
          Nenhum fornecedor vinculado a este produto (Produto x Fornecedor no Omie ou vínculo manual
          de Compras). Sem fornecedor, a quantidade de reposição fica indisponível.
        </p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {d.suppliers.map((s) => (
            <li key={s.supplierId} className="flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {s.name}
                  {s.isPreferred && <Badge className="font-normal">Principal</Badge>}
                  {s.leadTimeStatus === "teste" && (
                    <Badge variant="outline" className="font-normal">
                      Simulação
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground">
                  {s.leadTimeDays
                    ? `${s.leadTimeDays} dias corridos (${s.leadTimeSource === "produto" ? "deste produto" : "padrão do fornecedor"})`
                    : "Sem prazo de entrega informado"}
                  {s.minLot ? ` · lote mínimo ${quantity(s.minLot)}` : ""}
                  {s.supplierCode ? ` · cód. do fornecedor ${s.supplierCode}` : ""}
                  {s.manual && !s.inOmie ? " · vínculo manual" : ""}
                </p>
                {s.updatedAt && (
                  <p className="text-xs text-muted-foreground">
                    {s.note} · {dateTime(s.updatedAt)}
                  </p>
                )}
              </div>
              {d.canEdit && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="min-h-11 min-w-11"
                    aria-label={`Prazo de ${s.name} para este produto`}
                    onClick={() =>
                      setLead({
                        companyId,
                        supplierId: s.supplierId,
                        supplierName: s.name,
                        omieProductId,
                        productName,
                        current:
                          s.leadTimeSource === "produto" && s.leadTimeDays
                            ? { leadTimeDays: s.leadTimeDays, minLot: s.minLot }
                            : null,
                      })
                    }
                  >
                    <Pencil aria-hidden />
                  </Button>
                  {!s.isPreferred && d.suppliers.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11"
                      aria-label={`Tornar ${s.name} o fornecedor principal`}
                      onClick={() =>
                        setAction({
                          title: "Fornecedor principal",
                          description: `${s.name} passa a ser o fornecedor da reposição deste produto.`,
                          confirm: "Definir como principal",
                          hint: "por que este fornecedor",
                          done: "Fornecedor principal definido.",
                          run: (note) =>
                            suppliersApi.setPreferred({
                              companyId,
                              omieProductId,
                              supplierId: s.supplierId,
                              note,
                            }),
                        })
                      }
                    >
                      <Star aria-hidden />
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {d.suppliers.length > 1 && !d.preferred && (
        <p className="text-xs text-muted-foreground">
          Sem fornecedor principal: com mais de um fornecedor com prazo, a reposição espera Compras
          indicar o principal.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Prazo em dias corridos; o do produto prevalece sobre o padrão do fornecedor. Mudanças valem
        a partir da próxima análise.{" "}
        <Link to="/estoque/fornecedores" className="text-primary hover:underline">
          Fornecedores e prazos
        </Link>
      </p>
      <LeadTimeDialog
        target={lead}
        onClose={() => setLead(null)}
        onSaved={() => {
          setLead(null);
          reload();
        }}
      />
      <NoteActionDialog
        action={action}
        onClose={() => setAction(null)}
        onDone={() => {
          setAction(null);
          reload();
        }}
      />
    </div>
  );
}
