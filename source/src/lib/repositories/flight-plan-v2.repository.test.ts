/**
 * Contrato SQL × TypeScript do Plano de Voo. As respostas em __fixtures__/datasets.json saíram das
 * funções REAIS da migração 0050 num banco de exemplo (ops/tools/pglite/fp_dump.mjs): se um nome de
 * campo mudar de um lado só, estes números quebram em vez de virar um valor vazio em silêncio.
 */
import { describe, expect, it } from "vitest";
import datasetsRaw from "./__fixtures__/datasets.json?raw";
import {
  bootstrap,
  getPlan,
  getTargetLists,
  getTargets,
  getYear,
  invalidateCompany,
  listAlerts,
  listHistory,
  previewTargets,
} from "./flight-plan-v2.repository.server";
import { buildFlightPlan } from "./flight-plan.repository.server";

type Json = Record<string, unknown>;
const fx = JSON.parse(datasetsRaw) as {
  ids: Record<string, string>;
  today: string;
  admin: Record<string, unknown>;
  gestor: Record<string, unknown>;
  vendedor: Record<string, unknown>;
  gestorSemEquipe: Record<string, unknown>;
  vendedorSemVinculo: Record<string, unknown>;
};
const C = fx.ids["c"]!;
type Persona = "admin" | "gestor" | "vendedor" | "gestorSemEquipe" | "vendedorSemVinculo";

/** Banco falso: devolve as respostas reais gravadas e registra cada chamada. */
function fakeDb(persona: Persona) {
  const calls: { name: string; args: Json }[] = [];
  const p = fx[persona];
  const responses: Record<string, (a: Json) => unknown> = {
    data_as_of: () => fx.today,
    flight_plan_v2_me: () => p["me"],
    flight_plan_v2_dataset: (a) =>
      a["p_channel"] === "varejo" ? fx.admin["datasetVarejo"] : p["dataset"],
    flight_plan_v2_year: () => p["year"] ?? fx.admin["year"],
    flight_plan_v2_target_lists: () => p["lists"] ?? fx.admin["lists"],
    flight_plan_targets_month: () => p["targets"],
    flight_plan_history: () => (persona === "admin" ? fx.admin["history"] : p["history"]),
    flight_plan_sync_alerts: (a) =>
      (a["p_alerts"] as { key: string }[]).map((x) => ({
        key: x.key,
        state: "OPEN",
        reopened: false,
        note: null,
        initiativeId: null,
        updatedAt: null,
        firstSeen: fx.today,
      })),
  };
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "in", "gte", "lte", "is", "order", "limit", "select"]) c[m] = () => c;
    c["then"] = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(ok);
    return c;
  };
  const db = {
    rpc: (name: string, args?: Json) => {
      calls.push({ name, args: args ?? {} });
      const f = responses[name];
      return Promise.resolve(
        f
          ? { data: f(args ?? {}), error: null }
          : { data: null, error: { code: "42883", message: `função ${name} ausente no teste` } },
      );
    },
    from: () => ({ select: () => chain([]) }),
  };
  return { db: db as never, calls };
}

/** Nenhum número inválido nem campo indefinido em lugar nenhum da resposta. */
function assertClean(value: unknown, path = "$") {
  if (value === undefined) throw new Error(`indefinido em ${path}`);
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error(`número inválido em ${path}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertClean(v, `${path}[${i}]`));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) assertClean(v, `${path}.${k}`);
}

const Q = { companyId: C, month: "2026-11" };

describe("Plano de Voo: leitura real × servidor", () => {
  it("Admin: mês completo, meta da empresa, conciliação, indicadores e trimestre/ano", async () => {
    invalidateCompany(C);
    const { db } = fakeDb("admin");
    const p = await getPlan(db, fx.ids["adm"]!, Q);
    assertClean(p);
    expect(p.summary.realized).toBe(650);
    expect(p.targetSource).toBe("company");
    expect(p.summary.target).toBe(1000);
    expect(p.sellers).toHaveLength(4);
    expect(p.reconciliation).toMatchObject({
      difference: 50,
      reason: "Notas sem vendedor associado",
    });
    expect(p.indicators).toMatchObject({
      invoices: 4,
      customers: 3,
      newCustomers: 2,
      recurringCustomers: 1,
    });
    expect(p.indicators.averageTicket).toBe(162.5);
    expect(p.indicators.openQuotes).toEqual({ count: 1, amount: 500, avgAgeDays: 30 });
    expect(p.indicators.conversion.status).toBe("forming");
    expect(p.indicators.comparison.previousMonthSameCut).toBe(400);
    expect(p.summary.lateOrdersAmount).toBe(1000);
    expect(p.summary.forecastCommit).toBe(120);
    expect(p.sellers.find((s) => s.seller.name === "Ana FP")).toMatchObject({
      lateOrders: 1,
      openOrders: 1,
    });
    expect(p.sellers.find((s) => s.seller.name === "Licitação")?.seller.channel).toBe("licitacao");
    // Sábado 0,33 na MAG Filial (configuração da 0050) e feriado com peso 0.
    expect(p.calendar.find((d) => d.date === "2026-11-07")?.weight).toBe(0.33);
    expect(p.calendar.find((d) => d.date === "2026-11-02")?.weight).toBe(0);
    expect(p.weeks).toHaveLength(6);
    expect(p.months).toHaveLength(12);
    expect(p.months[10]).toMatchObject({ target: 1000, realized: 650 });
    expect(p.months[9]).toMatchObject({ target: 280, realized: 400 });
    expect(p.quarter.label).toBe("4º trimestre 2026");
    expect(p.year).toMatchObject({ missingTarget: 10 });
  });

  it("Canal Varejo: só os vendedores e as notas do canal, meta do canal", async () => {
    const { db } = fakeDb("admin");
    const p = await getPlan(db, fx.ids["adm"]!, { ...Q, channel: "varejo" });
    assertClean(p);
    expect(p.summary.realized).toBe(350);
    expect(p.sellers).toHaveLength(3);
    expect(p.summary.target).toBe(1000);
  });

  it("Gestor: só a equipe, meta = soma dos vendedores dele", async () => {
    const { db } = fakeDb("gestor");
    const p = await getPlan(db, fx.ids["ges"]!, Q);
    assertClean(p);
    expect(p.sellers.map((s) => s.seller.name)).toEqual(["Ana FP"]);
    expect(p.targetSource).toBe("sellers");
    expect(p.summary.target).toBe(300);
    expect(p.summary.realized).toBe(100);
  });

  it("cache curto: a mesma consulta do mesmo usuário lê o banco uma vez; gravação limpa", async () => {
    invalidateCompany(C);
    const { db, calls } = fakeDb("admin");
    await getPlan(db, fx.ids["adm"]!, Q);
    await getPlan(db, fx.ids["adm"]!, Q);
    expect(calls.filter((c) => c.name === "flight_plan_v2_dataset")).toHaveLength(1);
    invalidateCompany(C);
    await getPlan(db, fx.ids["adm"]!, Q);
    expect(calls.filter((c) => c.name === "flight_plan_v2_dataset")).toHaveLength(2);
    const args = calls.find((c) => c.name === "flight_plan_v2_dataset")!.args;
    expect(args["p_windows"]).toEqual({
      previous: { start: "2026-10-01", end: "2026-10-18" },
      lastYear: { start: "2025-11-01", end: "2025-11-18" },
      trailing3: { start: "2026-08-01", end: "2026-10-31", divisor: 3 },
    });
  });

  it("alertas: pedidos vencidos e calendário do ano seguinte, com presença registrada", async () => {
    invalidateCompany(C);
    const { db, calls } = fakeDb("admin");
    const alerts = await listAlerts(db, fx.ids["adm"]!, Q);
    assertClean(alerts);
    const types = alerts.map((a) => a.type);
    expect(types).toContain("LATE_ORDERS");
    expect(types).toContain("NO_CALENDAR");
    expect(alerts.find((a) => a.type === "LATE_ORDERS")?.key).toBe(
      `LATE_ORDERS:${C}:empresa:2026-11`,
    );
    expect(alerts.every((a) => a.firstSeen === fx.today)).toBe(true);
    const sync = calls.find((c) => c.name === "flight_plan_sync_alerts")!.args;
    expect((sync["p_subjects"] as string[])[0]).toBe("empresa");
  });

  it("Destino: grade, sugestão, não distribuído e prévia do lote", async () => {
    const { db } = fakeDb("admin");
    const t = await getTargets(db, C, "2026-11");
    assertClean(t);
    expect(t.company[0]).toEqual({
      channel: "varejo",
      targets: { BASE: null, ACTIVE: 1000, CHALLENGE: null },
    });
    expect(t.undistributed.ACTIVE).toBe(450);
    expect(t.readOnlyReason).toBeNull();
    const ana = t.sellers.find((s) => s.seller.name === "Ana FP")!;
    expect(ana.previousMonth.ACTIVE).toBe(280);
    expect(ana.suggestion).toBe(0);
    expect(t.sellers.find((s) => s.seller.name === "Carla FP")!.suggestion).toBeNull();
    const pv = await previewTargets(db, C, "2026-11", [
      { scope: "seller", sellerId: fx.ids["s1"]!, level: "ACTIVE", amount: 350 },
      { scope: "company", channel: "varejo", level: "ACTIVE", amount: 1000 },
      { scope: "seller", sellerId: fx.ids["s3"]!, level: "BASE", amount: 100 },
    ]);
    expect(pv).toMatchObject({ created: 1, updated: 1, removed: 0 });
    expect(pv.rows.map((r) => r.label)).toEqual(["Ana FP", "Carla FP"]);
  });

  it("Destino do Gestor: só a equipe, não edita a empresa, não distribuído da empresa toda", async () => {
    const { db } = fakeDb("gestor");
    const t = await getTargets(db, C, "2026-11");
    expect(t.sellers.map((s) => s.seller.name)).toEqual(["Ana FP"]);
    expect(t.canEditCompany).toBe(false);
    expect(t.undistributed.ACTIVE).toBe(450);
  });

  it("ano, listas de alvos, histórico e contexto do usuário", async () => {
    const { db } = fakeDb("admin");
    const y = await getYear(db, { companyId: C, year: 2026 });
    assertClean(y);
    expect(y).toHaveLength(12);
    expect(y[10]).toMatchObject({
      target: 1000,
      realized: 650,
      workdaysRemaining: expect.any(Number),
    });
    expect(y[9]!.cumulativeTarget).toBe(280);
    const lists = await getTargetLists(db, Q);
    assertClean(lists);
    expect(lists.map((l) => l.kind)).toEqual([
      "OPEN_QUOTES",
      "INACTIVE_CUSTOMERS",
      "LATE_ORDERS",
      "IDLE_STOCK",
    ]);
    expect(lists[0]!.items[0]).toMatchObject({
      label: "Q1 · Cliente novo",
      ageDays: 30,
      amount: 500,
    });
    expect(lists[2]!.count).toBe(1);
    const h = await listHistory(db, C);
    expect(h.map((e) => e.action)).toEqual(["Compromisso registrado", "Meta criada"]);
    expect(h[0]!.before).toContain("120");
    const b = await bootstrap(db);
    expect(b.me.roles).toEqual(["ADMIN"]);
    expect(b.companies[0]).toMatchObject({ slug: "mag-filial", saturdayWeight: 0.33 });
    expect(Object.keys(b.companies[0]!.channels ?? {}).sort()).toEqual([
      "licitacao",
      "outros",
      "varejo",
    ]);
    const v = await bootstrap(fakeDb("vendedor").db);
    expect(v.me.sellerId).toBe(fx.ids["s3"]);
  });

  it.each([
    ["gestorSemEquipe", "ges2"],
    ["vendedorSemVinculo", "ven2"],
  ] as const)(
    "%s (como as contas do teste na produção): tudo vazio e sem erro, nada da empresa",
    async (persona, id) => {
      invalidateCompany(C);
      const { db } = fakeDb(persona);
      const userId = fx.ids[id]!;
      const b = await bootstrap(db);
      expect(b.me.sellerId ?? null).toBeNull();
      const p = await getPlan(db, userId, Q);
      assertClean(p);
      expect(p.sellers).toEqual([]);
      expect(p.summary.realized).toBe(0);
      // Sem vendedor no escopo: "sem meta" (nunca a meta da empresa inteira).
      expect(p.targetSource).toBe("none");
      expect(p.summary.target ?? 0).toBe(0);
      expect(p.months).toHaveLength(12);
      const alerts = await listAlerts(db, userId, Q);
      assertClean(alerts);
      // O alerta é do escopo da pessoa, nunca o da empresa inteira.
      expect(alerts.every((a) => !a.key.includes(":empresa:"))).toBe(true);
      const t = await getTargets(db, C, "2026-11");
      assertClean(t);
      expect(t.sellers).toEqual([]);
      expect(t.canEditCompany).toBe(false);
      const y = await getYear(db, { companyId: C, year: 2026 });
      assertClean(y);
      expect(y).toHaveLength(12);
      expect(y.every((m) => m.realized === 0)).toBe(true);
      const lists = await getTargetLists(db, Q);
      assertClean(lists);
      expect(lists.filter((l) => l.kind !== "IDLE_STOCK").every((l) => l.count === 0)).toBe(true);
      expect(await listHistory(db, C)).toEqual([]);
    },
  );

  it("telas legadas (Vendedores, Vendedor 360, Vendas) com os mesmos números", async () => {
    const { db } = fakeDb("admin");
    const dto = await buildFlightPlan(db, { company: C, period: "2026-11" });
    assertClean(dto);
    expect(dto.summary.realized).toBe(650);
    expect(dto.targets.ACTIVE).toBe(1000);
    expect(dto.vendors).toHaveLength(4);
    expect(dto.timeline.find((d) => d.date === "2026-11-07")?.working).toBe(true);
    expect(dto.reconciliation.difference).toBe(50);
  });
});
