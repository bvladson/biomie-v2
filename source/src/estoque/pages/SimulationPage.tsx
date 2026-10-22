import { useCapabilities, useStockCompany } from "../lib/hooks";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CurveSlider } from "../components/CurveSlider";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { stockApi } from "../api";
import type { ScenarioInput } from "../api/contract";
import { ALL_CURVES, CURVES, PRESETS, simulate, chartProjection } from "../lib/simulation";
import { money, quantity, dateTime, errorMessage, downloadCsv } from "../lib/format";
import { PageTitle } from "../components/StockLayout";
import { CurveBadge, Metric, Notice, Status } from "../components/shared";
import { ProjectionChart } from "../components/ProjectionChart";
export function SimulationPage() {
  const { companyId } = useStockCompany(),
    client = useQueryClient(),
    caps = useCapabilities();
  const [scenario, setScenario] = useState<ScenarioInput>({
      cuts: { ...PRESETS.balanced.cuts },
      discount: 20,
    }),
    [name, setName] = useState(""),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [deleteId, setDeleteId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["stock", "simulation", companyId],
    queryFn: () => stockApi.simulationBase(companyId),
    enabled: caps.data?.viewCost === true,
    retry: false,
  });
  const saved = useQuery({
    queryKey: ["stock", "scenarios"],
    queryFn: () => stockApi.listScenarios(),
    enabled: caps.data?.viewCost === true,
    retry: false,
  });
  const result = useMemo(
    () => (q.data ? simulate(q.data.items, scenario) : null),
    [q.data, scenario],
  );
  const chart = useMemo(
    () => (q.data ? chartProjection(q.data.items, scenario) : null),
    [q.data, scenario],
  );
  const comparisons = useMemo(
    () =>
      q.data
        ? Object.entries(PRESETS).map(([key, p]) => ({
            key,
            preset: p,
            result: simulate(q.data.items, p),
          }))
        : [],
    [q.data],
  );
  return (
    <>
      <PageTitle
        title="Simulação de liquidação"
        description="Saída planejada por curva · sem novas compras"
      >
        {caps.data?.export && caps.data.viewCost && (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy || !result}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await stockApi.exportCsv({ kind: "simulation", companyId, scenario });
                downloadCsv(r.fileName, r.csv);
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Download className="size-4" />
            CSV · curvas e produtos
          </Button>
        )}
      </PageTitle>
      <Status
        loading={caps.isPending || (caps.data?.viewCost && q.isPending)}
        error={caps.error || q.error}
        empty={caps.data?.viewCost && q.data?.items.length === 0}
        retry={() => {
          caps.refetch();
          q.refetch();
        }}
      />
      {caps.data && !caps.data.viewCost && (
        <Notice>Seu perfil pode ver quantidades, mas não custos ou simulações.</Notice>
      )}
      {result && chart && q.data && q.data.items.length > 0 && caps.data?.viewCost && (
        <>
          {q.data.readAt && Date.now() - new Date(q.data.readAt).getTime() > 6 * 3600000 && (
            <Notice>Leitura com mais de 6 horas. Os números podem estar desatualizados.</Notice>
          )}
          <p className="text-xs text-muted-foreground">
            Base da leitura: {dateTime(q.data.readAt)} · Brasília
          </p>
          {result.totals.missingPrice > 0 && (
            <Notice>
              Receita parcial: {result.totals.missingPrice} posições com saída não têm preço de
              venda. A redução do estoque continua incluída.
            </Notice>
          )}
          <div aria-live="polite" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Estoque atual" value={money(result.totals.current)} />
            <Metric label="Estoque projetado" value={money(result.totals.projected)} />
            <Metric
              label="Redução a custo"
              value={money(result.totals.removed)}
              foot={`${result.totals.reduction.toFixed(1).replace(".", ",")}% do estoque atual`}
            />
            <Metric
              label={result.totals.missingPrice ? "Receita estimada · parcial" : "Receita estimada"}
              value={money(result.totals.revenue)}
              foot={`${quantity(result.totals.sold)} unidades de saída`}
            />
          </div>
          <section className="grid gap-8 border-y py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-5">
              <h2 className="text-lg font-semibold">Saída planejada</h2>
              {CURVES.map((c) => (
                <div key={c} className="space-y-3 border-b pb-5">
                  <div className="flex items-center justify-between">
                    <CurveBadge curve={c} />
                    <label className="flex items-center gap-2 text-sm">
                      <span className="sr-only">Saída da curva {c}</span>
                      <Input
                        aria-label={`Saída da curva ${c} em porcentagem`}
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        className="h-11 w-20 bg-card text-right"
                        value={scenario.cuts[c]}
                        onChange={(e) =>
                          setScenario({
                            ...scenario,
                            cuts: {
                              ...scenario.cuts,
                              [c]: Math.max(0, Math.min(100, Math.round(Number(e.target.value)))),
                            },
                          })
                        }
                      />
                      %
                    </label>
                  </div>
                  <CurveSlider
                    label={`Saída da curva ${c}`}
                    value={scenario.cuts[c]}
                    onChange={(v) =>
                      setScenario({ ...scenario, cuts: { ...scenario.cuts, [c]: v } })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {quantity(result.byCurve[c].sold)} unidades · {money(result.byCurve[c].removed)}{" "}
                    liberados
                  </p>
                </div>
              ))}
              <label className="flex items-center justify-between gap-4 text-sm">
                Desconto sobre o preço de venda
                <Input
                  aria-label="Desconto em porcentagem"
                  type="number"
                  min={0}
                  max={70}
                  step={1}
                  className="h-11 w-20 shrink-0 bg-card text-right"
                  value={scenario.discount}
                  onChange={(e) =>
                    setScenario({
                      ...scenario,
                      discount: Math.max(0, Math.min(70, Math.round(Number(e.target.value)))),
                    })
                  }
                />
              </label>
              <div className="flex justify-between gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setScenario({ cuts: { A: 0, B: 0, C: 0, D: 0 }, discount: 0 })}
                >
                  Zerar cortes
                </Button>
                {caps.data.saveScenarios && (
                  <Button
                    className="min-h-11"
                    disabled={(saved.data?.length ?? 0) >= 5}
                    onClick={() => {
                      setName("");
                      setOpen(true);
                    }}
                  >
                    <Save className="size-4" />
                    Salvar cenário
                  </Button>
                )}
              </div>
            </div>
            <div className="min-w-0 space-y-5">
              <h2 className="text-lg font-semibold">Atual × projetado por curva</h2>
              <ProjectionChart data={chart.data} />
              {chart.excludedCount > 0 && (
                <Notice>
                  {chart.excludedCount} posições negativas ({money(chart.excludedValue)}) fora das
                  barras, preservadas nos totais.
                </Notice>
              )}
              <div className="border-y py-5">
                <p className="text-sm text-muted-foreground">Capital em C + D</p>
                <p className="mt-2 break-words text-xl font-semibold">
                  {money(result.byCurve.C.current + result.byCurve.D.current)} →{" "}
                  {money(result.byCurve.C.projected + result.byCurve.D.projected)}
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                Sem curva e saldo negativo não têm saída na simulação. Receita sem impostos, frete
                ou outras despesas.
              </p>
            </div>
          </section>
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Cenários de referência</h2>
            <div className="grid gap-4 md:grid-cols-3">
              {comparisons.map((c) => (
                <article key={c.key} className="space-y-3 rounded-lg border bg-card p-5">
                  <h3 className="font-semibold">{c.preset.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    A {c.preset.cuts.A}% · B {c.preset.cuts.B}% · C {c.preset.cuts.C}% · D{" "}
                    {c.preset.cuts.D}%
                  </p>
                  <p className="text-sm">Desconto {c.preset.discount}%</p>
                  <p className="text-xs text-muted-foreground">Estoque projetado</p>
                  <p className="break-words text-xl font-semibold">
                    {money(c.result.totals.projected)}
                  </p>
                  <p className="text-sm">
                    Receita {c.result.totals.missingPrice ? "parcial" : "estimada"}:{" "}
                    {money(c.result.totals.revenue)}
                  </p>
                  <Button
                    variant="outline"
                    className="min-h-11 w-full"
                    onClick={() =>
                      setScenario({ cuts: { ...c.preset.cuts }, discount: c.preset.discount })
                    }
                  >
                    Aplicar {c.preset.name}
                  </Button>
                </article>
              ))}
            </div>
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Cenários salvos ({saved.data?.length ?? 0}/5)</h2>
            {saved.error && <Status error={saved.error} retry={() => saved.refetch()} />}
            {saved.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhum cenário salvo.</p>
            )}
            <div className="flex flex-wrap gap-3">
              {saved.data?.map((s) => (
                <div key={s.id} className="flex max-w-full items-center rounded-md border bg-card">
                  <Button
                    variant="ghost"
                    className="min-h-11 h-auto whitespace-normal break-words text-left"
                    onClick={() => setScenario({ cuts: { ...s.cuts }, discount: s.discount })}
                  >
                    {s.name}
                  </Button>
                  {caps.data?.saveScenarios && (
                    <Button
                      aria-label={`Excluir cenário ${s.name}`}
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11"
                      onClick={() => setDeleteId(s.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Resultado por curva</h2>
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table className="min-w-[850px]">
                <TableHeader>
                  <TableRow>
                    {[
                      "Curva",
                      "Atual",
                      "Redução",
                      "Projetado",
                      "Receita",
                      "Unidades",
                      "Saída",
                      "Posições",
                      "Sem preço",
                    ].map((h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ALL_CURVES.map((c) => {
                    const r = result.byCurve[c];
                    return (
                      <TableRow key={c}>
                        <TableCell>
                          <CurveBadge curve={c} />
                        </TableCell>
                        <TableCell>{money(r.current)}</TableCell>
                        <TableCell>{money(r.removed)}</TableCell>
                        <TableCell>{money(r.projected)}</TableCell>
                        <TableCell>{money(r.revenue)}</TableCell>
                        <TableCell>{quantity(r.units)}</TableCell>
                        <TableCell>{r.sold}</TableCell>
                        <TableCell>{r.skus}</TableCell>
                        <TableCell>{r.missingPrice}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Salvar cenário</DialogTitle>
            <DialogDescription>
              Até 5 cenários pessoais. Os valores serão recalculados com a base selecionada.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            Nome do cenário
            <Input
              aria-label="Nome do cenário"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              disabled={busy || !name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await stockApi.saveScenario({ ...scenario, name });
                  setOpen(false);
                  await client.invalidateQueries({ queryKey: ["stock", "scenarios"] });
                  toast.success("Cenário salvo.");
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteId !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir cenário?</DialogTitle>
            <DialogDescription>
              Essa ação remove o cenário salvo, sem alterar o estoque.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!deleteId) return;
                setBusy(true);
                try {
                  await stockApi.deleteScenario(deleteId);
                  setDeleteId(null);
                  client.invalidateQueries({ queryKey: ["stock", "scenarios"] });
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
