/**
 * Fornecedores e prazos de entrega (migração 0048). Fornecedores e vínculos vêm do Omie (Produto x
 * Fornecedor, só leitura); o prazo de entrega é informado aqui por Compras ou pelo Super admin, por empresa,
 * fornecedor e produto (ou o padrão do fornecedor). Os demais perfis só consultam.
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Link2, Pencil, RefreshCw, Star, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { stockApi } from "../api";
import { suppliersApi } from "../api/suppliers";
import type {
  ChangeValues,
  SupplierChange,
  SupplierDetail,
  SupplierListRow,
  SupplierStatusFilter,
} from "../api/suppliers-contract";
import { PageTitle } from "../components/StockLayout";
import { Choice, CurveBadge, Notice, Status } from "../components/shared";
import { StatTile } from "../components/IntelBits";
import {
  LeadTimeDialog,
  NoteActionDialog,
  type LeadTimeTarget,
  type NoteAction,
} from "../components/SupplierDialogs";
import { dateTime, errorMessage, quantity } from "../lib/format";
import { integer } from "../lib/intel";
import { useStockCompany } from "../lib/hooks";

const STATUS: { value: SupplierStatusFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "com_estoque", label: "Com produto em estoque" },
  { value: "sem_prazo", label: "Sem prazo informado" },
  { value: "com_prazo", label: "Com prazo informado" },
  { value: "teste", label: "Com prazo de teste" },
];

const pct = (part: number, total: number) =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : "—";

function LeadTimeText({
  days,
  status,
  fallback,
}: {
  days: number | null | undefined;
  status?: string | null | undefined;
  fallback: string;
}) {
  if (!days) return <span className="text-muted-foreground">{fallback}</span>;
  return (
    <span className="tabular-nums">
      {days} dias
      {status === "teste" && (
        <span className="ml-1.5 inline-flex rounded-md border px-1.5 py-0.5 text-xs font-normal">
          Simulação
        </span>
      )}
    </span>
  );
}

const KIND_LABELS: Record<SupplierChange["kind"], string> = {
  prazo: "Prazo de entrega",
  fornecedor_principal: "Fornecedor principal",
  vinculo: "Vínculo com produto",
  politica: "Política de reposição",
};
const CHANGE_LABELS: Record<SupplierChange["change"], string> = {
  create: "incluído",
  update: "alterado",
  remove: "removido",
};

function values(v: ChangeValues | null) {
  if (!v) return "—";
  const parts: string[] = [];
  if (typeof v["leadTimeDays"] === "number") parts.push(`${v["leadTimeDays"]} dias`);
  if (typeof v["minLot"] === "number") parts.push(`lote ${quantity(v["minLot"])}`);
  if (v["status"] === "teste") parts.push("teste");
  if (typeof v["principal"] === "string") parts.push(v["principal"]);
  if (typeof v["reviewDays"] === "number") parts.push(`revisão ${v["reviewDays"]} dias`);
  if (typeof v["serviceLevel"] === "number")
    parts.push(`serviço ${Math.round(v["serviceLevel"] * 100)}%`);
  if (typeof v["manual"] === "boolean")
    parts.push(v["manual"] ? "vínculo manual" : v["omie"] ? "só do Omie" : "sem vínculo");
  return parts.join(" · ") || "—";
}

function SupplierSheet({
  companyId,
  supplier,
  onClose,
}: {
  companyId: string;
  supplier: SupplierListRow | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["stock", "suppliers", "detail", companyId, supplier?.supplierId ?? null],
    queryFn: () => suppliersApi.detail(companyId, supplier!.supplierId),
    enabled: supplier !== null,
    retry: false,
  });
  const [filter, setFilter] = useState("");
  const [lead, setLead] = useState<LeadTimeTarget | null>(null);
  const [action, setAction] = useState<NoteAction | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkDebounced, setLinkDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setLinkDebounced(linkSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [linkSearch]);
  const d: SupplierDetail | undefined = q.data;
  const linkResults = useQuery({
    queryKey: ["stock", "suppliers", "link-search", companyId, linkDebounced],
    queryFn: () =>
      stockApi.positions({ companyId, search: linkDebounced, view: "product", page: 0 }),
    enabled: Boolean(d?.canEdit) && linkDebounced.length >= 3,
    retry: false,
  });
  const reload = () => {
    void client.invalidateQueries({ queryKey: ["stock", "suppliers"] });
    void client.invalidateQueries({ queryKey: ["stock", "options"] });
  };
  const products = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (d?.products ?? []).filter(
      (p) =>
        !f || `${p.sku ?? ""} ${p.name ?? ""} ${p.supplierCode ?? ""}`.toLowerCase().includes(f),
    );
  }, [d, filter]);
  const linked = new Set((d?.products ?? []).map((p) => p.omieProductId));
  return (
    <Sheet open={supplier !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader className="mb-4">
          <SheetTitle className="pr-6">{d?.name ?? supplier?.name ?? "Fornecedor"}</SheetTitle>
          <SheetDescription>
            {d
              ? [
                  d.legalName && d.legalName !== d.name ? d.legalName : null,
                  [d.city, d.state].filter(Boolean).join("/") || null,
                  `código ${d.supplierId} no Omie`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Prazos e produtos do fornecedor nesta empresa."}
          </SheetDescription>
        </SheetHeader>
        {q.isPending && supplier !== null ? (
          <div className="space-y-3" aria-busy="true" aria-label="Carregando fornecedor">
            <Skeleton className="h-16" />
            <Skeleton className="h-56" />
          </div>
        ) : q.error ? (
          <p role="alert" className="text-sm">
            {errorMessage(q.error)}
          </p>
        ) : d ? (
          <div className="space-y-6">
            {!d.inOmie && (
              <Notice>
                Este fornecedor não veio na última importação do Omie (Produto x Fornecedor). Os
                vínculos manuais e os prazos informados continuam valendo.
              </Notice>
            )}
            <section className="panel space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">Prazo padrão do fornecedor</h3>
                  <p className="text-sm text-muted-foreground">
                    Vale para os produtos dele nesta empresa que não têm prazo próprio.
                  </p>
                </div>
                {d.canEdit && (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() =>
                      setLead({
                        companyId,
                        supplierId: d.supplierId,
                        supplierName: d.name,
                        current: d.defaultLeadTime,
                      })
                    }
                  >
                    <Pencil aria-hidden /> {d.defaultLeadTime ? "Alterar" : "Informar prazo"}
                  </Button>
                )}
              </div>
              <div className="text-lg">
                <LeadTimeText
                  days={d.defaultLeadTime?.leadTimeDays}
                  status={d.defaultLeadTime?.status}
                  fallback="Sem prazo padrão informado"
                />
                {d.defaultLeadTime?.minLot ? (
                  <span className="ml-2 text-sm text-muted-foreground">
                    lote mínimo {quantity(d.defaultLeadTime.minLot)}
                  </span>
                ) : null}
              </div>
              {d.defaultLeadTime && (
                <p className="text-xs text-muted-foreground">
                  {d.defaultLeadTime.note} · {d.defaultLeadTime.updatedBy ?? ""}{" "}
                  {dateTime(d.defaultLeadTime.updatedAt)}
                </p>
              )}
              {d.defaultLeadTime?.status === "teste" && (
                <p className="text-xs">
                  Prazo configurado na simulação (homologação). O prazo deve ser confirmado por
                  Compras antes de servir de base a recomendações reais.
                </p>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h3 className="text-base font-semibold">
                  Produtos vinculados ({integer(d.products.length)})
                </h3>
                <label className="w-64 min-w-0 space-y-1.5">
                  <span className="block text-xs font-medium text-muted-foreground">
                    Filtrar produtos
                  </span>
                  <Input
                    value={filter}
                    maxLength={120}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="SKU, nome ou código do fornecedor"
                    className="h-11 bg-card"
                  />
                </label>
              </div>
              <div className="panel overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produto</TableHead>
                      <TableHead className="text-right">Saldo</TableHead>
                      <TableHead>Prazo</TableHead>
                      <TableHead>Principal</TableHead>
                      {d.canEdit && <TableHead />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.slice(0, 300).map((p) => (
                      <TableRow key={p.omieProductId}>
                        <TableCell className="min-w-56 max-w-72 whitespace-normal">
                          <span className="font-medium">{p.name ?? p.sku ?? p.omieProductId}</span>
                          <span className="block text-xs text-muted-foreground">
                            {[
                              p.sku,
                              p.supplierCode ? `cód. do fornecedor ${p.supplierCode}` : null,
                              p.manual && !p.inOmie
                                ? "vínculo manual"
                                : p.manual
                                  ? "Omie + manual"
                                  : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <span className="mt-1 inline-block">
                            <CurveBadge curve={p.curve} />
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.qty === null ? "—" : quantity(p.qty)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          {p.leadTime ? (
                            <LeadTimeText
                              days={p.leadTime.leadTimeDays}
                              status={p.leadTime.status}
                              fallback=""
                            />
                          ) : d.defaultLeadTime ? (
                            <span className="text-muted-foreground">
                              padrão: {d.defaultLeadTime.leadTimeDays} dias
                            </span>
                          ) : (
                            <span className="text-muted-foreground">sem prazo</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {p.preferred === "este" ? (
                            <Badge className="font-normal">Este fornecedor</Badge>
                          ) : p.preferred === "outro" ? (
                            <span className="text-muted-foreground">{p.preferredName}</span>
                          ) : p.otherSuppliers > 0 ? (
                            <span className="text-muted-foreground">
                              a definir ({p.otherSuppliers + 1} fornecedores)
                            </span>
                          ) : (
                            <span className="text-muted-foreground">único</span>
                          )}
                        </TableCell>
                        {d.canEdit && (
                          <TableCell className="whitespace-nowrap">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="min-h-11 min-w-11"
                              aria-label={`Prazo de ${p.name ?? p.omieProductId}`}
                              onClick={() =>
                                setLead({
                                  companyId,
                                  supplierId: d.supplierId,
                                  supplierName: d.name,
                                  omieProductId: p.omieProductId,
                                  productName: p.name,
                                  current: p.leadTime,
                                })
                              }
                            >
                              <Pencil aria-hidden />
                            </Button>
                            {p.preferred !== "este" && p.otherSuppliers > 0 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="min-h-11 min-w-11"
                                aria-label={`Tornar ${d.name} o fornecedor principal de ${p.name ?? p.omieProductId}`}
                                onClick={() =>
                                  setAction({
                                    title: "Fornecedor principal",
                                    description: `${d.name} passa a ser o fornecedor da reposição de ${p.name ?? p.omieProductId}${p.preferredName ? ` (no lugar de ${p.preferredName})` : ""}.`,
                                    confirm: "Definir como principal",
                                    hint: "por que este fornecedor",
                                    done: "Fornecedor principal definido.",
                                    run: (note) =>
                                      suppliersApi.setPreferred({
                                        companyId,
                                        omieProductId: p.omieProductId,
                                        supplierId: d.supplierId,
                                        note,
                                      }),
                                  })
                                }
                              >
                                <Star aria-hidden />
                              </Button>
                            )}
                            {p.manual && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="min-h-11 min-w-11"
                                aria-label={`Remover o vínculo manual de ${p.name ?? p.omieProductId}`}
                                onClick={() =>
                                  setAction({
                                    title: "Remover vínculo manual",
                                    description: p.inOmie
                                      ? "O vínculo continua porque também está no Omie; só deixa de ser manual."
                                      : "O produto deixa de ser deste fornecedor no BIOMIE. O prazo deste produto com ele e, se for o caso, o fornecedor principal saem junto (ficam no histórico).",
                                    confirm: "Remover vínculo",
                                    destructive: true,
                                    hint: "o motivo",
                                    done: "Vínculo manual removido.",
                                    run: (note) =>
                                      suppliersApi.setLink({
                                        companyId,
                                        omieProductId: p.omieProductId,
                                        supplierId: d.supplierId,
                                        linked: false,
                                        note,
                                      }),
                                  })
                                }
                              >
                                <Unlink aria-hidden />
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                    {products.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={d.canEdit ? 5 : 4} className="py-8 text-center">
                          Nenhum produto.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {products.length > 300 && (
                <p className="text-xs text-muted-foreground">
                  Mostrando 300 de {integer(products.length)}: use o filtro para achar um produto.
                </p>
              )}
            </section>

            {d.canEdit && (
              <section className="panel space-y-3 p-4">
                <h3 className="text-base font-semibold">Vincular outro produto</h3>
                <p className="text-sm text-muted-foreground">
                  Para um produto que o Omie não liga a este fornecedor. O vínculo do Omie (Produto
                  x Fornecedor) só muda no Omie.
                </p>
                <Input
                  value={linkSearch}
                  maxLength={120}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  placeholder="Buscar produto por SKU ou nome (3 letras ou mais)"
                  className="h-11 bg-card"
                />
                {linkResults.data && (
                  <ul className="divide-y text-sm">
                    {linkResults.data.rows
                      .filter((r) => !linked.has(r.omieProductId))
                      .slice(0, 10)
                      .map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{r.name}</span>
                            <span className="text-xs text-muted-foreground">{r.sku}</span>
                          </span>
                          <Button
                            variant="outline"
                            className="min-h-11"
                            onClick={() =>
                              setAction({
                                title: "Vincular produto",
                                description: `${r.name} passa a ter ${d.name} como fornecedor nesta empresa.`,
                                confirm: "Vincular",
                                hint: "de onde vem a informação",
                                done: "Produto vinculado.",
                                run: (note) =>
                                  suppliersApi.setLink({
                                    companyId,
                                    omieProductId: r.omieProductId,
                                    supplierId: d.supplierId,
                                    linked: true,
                                    note,
                                  }),
                              })
                            }
                          >
                            <Link2 aria-hidden /> Vincular
                          </Button>
                        </li>
                      ))}
                  </ul>
                )}
              </section>
            )}

            {d.orphanLeadTimes.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-base font-semibold">Prazos sem vínculo ativo</h3>
                <p className="text-sm text-muted-foreground">
                  O Omie não liga mais estes produtos a este fornecedor: os prazos ficam guardados,
                  mas não entram na reposição.
                </p>
                <ul className="divide-y text-sm">
                  {d.orphanLeadTimes.map((o) => (
                    <li key={o.omieProductId} className="flex justify-between gap-3 py-2">
                      <span>{o.name ?? o.sku ?? o.omieProductId}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {o.leadTimeDays} dias · {dateTime(o.updatedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {d.history && (
              <section className="space-y-2">
                <h3 className="text-base font-semibold">Histórico de alterações</h3>
                {d.history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhuma alteração ainda.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {d.history.map((h, i) => (
                      <li key={`${h.at}-${i}`} className="space-y-0.5 py-2">
                        <p>
                          <strong>
                            {KIND_LABELS[h.kind]} {CHANGE_LABELS[h.change]}
                          </strong>
                          {h.productName || h.omieProductId
                            ? ` · ${h.productName ?? h.omieProductId}`
                            : " · padrão do fornecedor"}
                        </p>
                        <p className="text-muted-foreground">
                          Antes: {values(h.before)} → Depois: {values(h.after)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {h.by} · {dateTime(h.at)}
                          {h.note ? ` · ${h.note}` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        ) : null}
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
            setLinkSearch("");
            reload();
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

export function SuppliersPage() {
  const { companyId } = useStockCompany();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<SupplierStatusFilter>("com_estoque");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<SupplierListRow | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(0), [companyId, debounced, status]);
  const query = { companyId, search: debounced || undefined, status, page };
  const q = useQuery({
    queryKey: ["stock", "suppliers", "list", query],
    queryFn: () => suppliersApi.list(query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = q.data;
  const s = data?.summary;
  const job = s?.lastJob;
  return (
    <div className="space-y-6">
      <PageTitle
        title="Fornecedores e prazos de entrega"
        description="Fornecedores e vínculos vêm do Omie (Produto x Fornecedor, só leitura). O prazo de entrega não existe na API do Omie: Compras informa aqui, por fornecedor e produto. Sem prazo confiável, a reposição não sugere quantidade."
      >
        {data?.canImport && companyId !== "all" && (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy || job?.status === "queued" || job?.status === "running"}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await suppliersApi.requestImport(companyId);
                toast.success(
                  r.queued
                    ? "Importação pedida: o worker lê o Omie na próxima rodada."
                    : r.inProgress
                      ? "Já há uma importação em andamento."
                      : `Nova importação a partir de ${dateTime(r.nextAllowedAt)}.`,
                );
                void client.invalidateQueries({ queryKey: ["stock", "suppliers"] });
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw aria-hidden /> Atualizar do Omie
          </Button>
        )}
      </PageTitle>
      <Notice>
        Quem altera: Compras (permissão "Estoque: fornecedores e prazos") e o Super admin, sempre
        com observação; tudo fica no histórico e na Auditoria. Quem consulta: perfis que veem custo
        e Compras (o Comercial vê previsões e reposições, sem fornecedores). Prazo em dias corridos;
        o do produto prevalece sobre o padrão do fornecedor.
      </Notice>
      {(q.error || !data) && (
        <Status loading={q.isPending} error={q.error} retry={() => q.refetch()} />
      )}
      {data && s && (
        <>
          {s.testLeadTimes > 0 && (
            <Notice>
              Homologação: {integer(s.testLeadTimes)} prazo(s) de teste (prazo configurado na
              simulação). O prazo deve ser confirmado por Compras antes de servir de base a
              recomendações reais.
              {s.testLeadTimesOn ? "" : " O ajuste de teste está desligado: o motor não os usa."}
            </Notice>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Fornecedores no Omie"
              value={integer(s.suppliers)}
              foot={`${integer(s.links)} vínculos produto × fornecedor${s.manualLinks ? ` · ${integer(s.manualLinks)} manuais` : ""}`}
            />
            <StatTile
              label="Produtos em estoque com fornecedor"
              value={pct(s.productsWithStockLinked, s.productsWithStock)}
              foot={`${integer(s.productsWithStockLinked)} de ${integer(s.productsWithStock)} com saldo`}
            />
            <StatTile
              label="Produtos em estoque com prazo confirmado"
              value={pct(s.productsWithStockConfirmed, s.productsWithStock)}
              foot={`${integer(s.productsWithStockConfirmed)} de ${integer(s.productsWithStock)} com saldo`}
            />
            <StatTile
              label="Última importação do Omie"
              value={s.lastImportAt ? dateTime(s.lastImportAt) : "Nunca"}
              foot={
                !s.importEnabled
                  ? "Importação automática desligada"
                  : job?.status === "failed"
                    ? `Falhou${job.error ? `: ${job.error}` : ""}`
                    : job?.status === "queued" || job?.status === "running"
                      ? `Em andamento (${job.pagesDone}${job.pagesTotal ? ` de ${job.pagesTotal}` : ""} páginas)`
                      : job?.error
                        ? job.error
                        : "Diária, só leitura"
              }
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="w-72 min-w-0 space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">Buscar</span>
              <Input
                value={search}
                maxLength={120}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Nome ou código do fornecedor"
                className="h-11 bg-card"
              />
            </label>
            <div className="w-64">
              <Choice
                label="Situação"
                value={status}
                onChange={(v) => setStatus(v as SupplierStatusFilter)}
                options={STATUS}
              />
            </div>
          </div>
          <div className={`panel overflow-hidden ${q.isPlaceholderData ? "opacity-60" : ""}`}>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead className="text-right">Produtos</TableHead>
                    <TableHead className="text-right">Com saldo</TableHead>
                    <TableHead>Prazo padrão</TableHead>
                    <TableHead className="text-right">Prazos por produto</TableHead>
                    <TableHead className="text-right">Principal em</TableHead>
                    <TableHead>Atualizado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.supplierId}>
                      <TableCell className="min-w-56 max-w-80 whitespace-normal">
                        <button
                          type="button"
                          className="text-left font-medium text-primary hover:underline"
                          onClick={() => setOpen(r)}
                        >
                          {r.name}
                        </button>
                        <span className="block text-xs text-muted-foreground">
                          {[
                            [r.city, r.state].filter(Boolean).join("/"),
                            r.inOmie ? null : "fora da última importação",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {integer(r.products)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {integer(r.productsWithStock)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        <LeadTimeText
                          days={r.leadTimeDays}
                          status={r.leadTimeStatus}
                          fallback="sem prazo"
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {integer(r.productLeadTimes)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {integer(r.preferredFor)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {r.updatedAt ? dateTime(r.updatedAt) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.total === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center">
                        {s.suppliers === 0 && !s.lastImportAt
                          ? "Nenhum fornecedor importado do Omie ainda."
                          : "Nenhum fornecedor nesta situação."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between gap-3 border-t p-3 text-sm">
              <span className="text-muted-foreground">
                {integer(data.total)} fornecedor{data.total === 1 ? "" : "es"}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label="Página anterior"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft aria-hidden />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label="Próxima página"
                  disabled={(page + 1) * 50 >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
      {companyId !== "all" && (
        <SupplierSheet companyId={companyId} supplier={open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
