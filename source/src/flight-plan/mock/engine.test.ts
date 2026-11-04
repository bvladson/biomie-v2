import { describe, expect, it } from "vitest";
import {
  buildCalendar,
  buildWeeks,
  classifyOrder,
  computeAlerts,
  computeMetrics,
  resolvePlanTarget,
  statusFromRatio,
  suggestion,
  sumWeights,
  undistributed,
  type AlertSubject,
} from "./engine";
import { createMockFlightPlan } from "../api/mock";
import { parseMoneyInput, parsePastedBlock } from "../lib/grid";
import { whatsappSummary } from "../lib/summary";

const H = new Map([
  ["2026-11-02", "Finados"],
  ["2026-11-15", "República"],
  ["2026-11-20", "Consciência Negra"],
]);

describe("calendário (D2 peso do sábado)", () => {
  it("sábado vale 0,33 na Mag Filial e na Uni Design e 0 nas demais", () => {
    const sat = buildCalendar("2026-11", 0.33, H).find((d) => d.date === "2026-11-07")!;
    expect(sat.weight).toBe(0.33);
    expect(buildCalendar("2026-11", 0, H).find((d) => d.date === "2026-11-07")!.weight).toBe(0);
  });
  it("feriado e domingo valem 0; novembro/2026 tem 19 dias úteis sem sábado e 20,32 com 0,33", () => {
    expect(sumWeights(buildCalendar("2026-11", 0, H))).toBe(19);
    expect(sumWeights(buildCalendar("2026-11", 0.33, H))).toBe(20.32); // 4 sábados × 0,33
  });
});

describe("carteira (D3 pedido vencido)", () => {
  const end = "2026-11-30",
    today = "2026-11-18";
  it("pedido com data de faturamento vencida pesa 30% e é atrasado", () => {
    const c = classifyOrder(
      {
        id: "1",
        sellerId: "s",
        customer: "",
        amount: 100,
        openedAt: "2026-11-10",
        expectedDate: "2026-11-15",
      },
      today,
      end,
    );
    expect(c.weight).toBe(0.3);
    expect(c.late).toBe(true);
  });
  it("idade: até 15 dias 90%, 16 a 45 60%, acima 30%; previsto após o mês fica fora", () => {
    const o = (openedAt: string, expectedDate: string | null = null) =>
      classifyOrder(
        { id: "1", sellerId: "s", customer: "", amount: 100, openedAt, expectedDate },
        today,
        end,
      ).weight;
    expect(o("2026-11-03")).toBe(0.9);
    expect(o("2026-11-02")).toBe(0.6);
    expect(o("2026-10-03")).toBe(0.3);
    expect(o("2026-11-17", "2026-12-05")).toBe(0);
  });
});

describe("métricas", () => {
  const cal = buildCalendar("2026-11", 0, H);
  it("ideal, gap, ritmos e previsões seguem as regras", () => {
    const m = computeMetrics({
      target: 190_000,
      realized: 100_000,
      calendar: cal,
      today: "2026-11-18",
      month: "2026-11",
      commits: [50_000, 60_000],
      orders: [
        {
          id: "a",
          sellerId: "s",
          customer: "",
          amount: 10_000,
          openedAt: "2026-11-10",
          expectedDate: null,
        },
        {
          id: "b",
          sellerId: "s",
          customer: "",
          amount: 20_000,
          openedAt: "2026-11-01",
          expectedDate: "2026-11-05",
        },
      ],
    });
    expect(m.workdaysElapsed).toBe(12);
    expect(m.workdaysRemaining).toBe(7);
    expect(m.idealToday).toBe(120_000);
    expect(m.deviation).toBe(-20_000);
    expect(m.remainingGap).toBe(90_000);
    expect(m.requiredDailyPace).toBe(12_857.14);
    expect(m.forecastBase).toBe(110_000);
    expect(m.forecastProbable).toBe(100_000 + 9_000 + 6_000);
    expect(m.lateOrdersAmount).toBe(20_000);
    expect(m.forecastCommit).toBe(110_000);
    expect(m.status).toBe("RISK"); // 100.000 ÷ 120.000 = 83%
  });
});

describe("status", () => {
  it("limiares 97%, 90%, 75%", () => {
    expect(statusFromRatio(0.97)).toBe("ON_TRACK");
    expect(statusFromRatio(0.9)).toBe("ATTENTION");
    expect(statusFromRatio(0.75)).toBe("RISK");
    expect(statusFromRatio(0.74)).toBe("CRITICAL");
  });
});

describe("metas (D1 empresa por canal + vendedores)", () => {
  it("usa a meta da empresa quando existe, senão a soma dos vendedores", () => {
    expect(
      resolvePlanTarget(
        { BASE: null, ACTIVE: 700_000, CHALLENGE: null },
        { BASE: null, ACTIVE: 680_000, CHALLENGE: null },
        "ACTIVE",
      ),
    ).toEqual({ target: 700_000, source: "company" });
    expect(
      resolvePlanTarget(
        { BASE: null, ACTIVE: null, CHALLENGE: null },
        { BASE: null, ACTIVE: 30_000, CHALLENGE: null },
        "ACTIVE",
      ),
    ).toEqual({ target: 30_000, source: "sellers" });
    expect(
      resolvePlanTarget(
        { BASE: null, ACTIVE: null, CHALLENGE: null },
        { BASE: null, ACTIVE: null, CHALLENGE: null },
        "ACTIVE",
      ).source,
    ).toBe("none");
  });
  it("não distribuído = empresa − vendedores (Mag Filial: faltam R$ 20.000)", () => {
    expect(
      undistributed(
        { BASE: 580_000, ACTIVE: 700_000, CHALLENGE: 830_000 },
        { BASE: null, ACTIVE: 680_000, CHALLENGE: null },
      ).ACTIVE,
    ).toBe(20_000);
  });
  it("sugestão = média de 3 meses arredondada a R$ 1.000", () => {
    expect(suggestion([10_400, 12_100, 11_000])).toBe(11_000);
  });
  it("meta da semana = meta × dias úteis da semana ÷ dias úteis do mês", () => {
    const weeks = buildWeeks(
      buildCalendar("2026-11", 0, H),
      new Map(),
      new Map(),
      [],
      190_000,
      "2026-11-18",
    );
    expect(weeks[1]!.workdays).toBe(4); // 02/11 feriado
    expect(weeks[1]!.target).toBe(40_000);
  });
});

describe("alertas", () => {
  const base = computeMetrics({
    target: 100,
    realized: 10,
    calendar: buildCalendar("2026-11", 0, H),
    today: "2026-11-18",
    month: "2026-11",
    orders: [],
    commits: [],
  });
  const subject: AlertSubject = {
    sellerId: null,
    name: "Empresa",
    metrics: base,
    hasTarget: true,
    plannedAmount: 0,
    lateOrders: [
      { amount: 1000, overdueDays: 3 },
      { amount: 2000, overdueDays: 21 },
    ],
    staleQuotes: [],
    idleWorkdays: null,
    statusLastMonday: "RISK",
  };
  it("gera pedido atrasado com evidência e mesma saída para os mesmos dados", () => {
    const a = computeAlerts(
      { companyId: "x", month: "2026-11", noTarget: false, calendarMissingYear: 2027 },
      [subject],
    );
    expect(a.find((x) => x.type === "LATE_ORDERS")!.evidence).toContain("2 pedidos");
    expect(a.find((x) => x.type === "LATE_ORDERS")!.evidence).toContain("3 a 21 dias");
    expect(a.map((x) => x.type)).toContain("NO_CALENDAR");
    expect(a.map((x) => x.type)).toContain("STATUS_WORSENED");
    expect(
      computeAlerts(
        { companyId: "x", month: "2026-11", noTarget: false, calendarMissingYear: 2027 },
        [subject],
      ),
    ).toEqual(a);
  });
});

describe("mock FlightPlanApi", () => {
  const mk = () => {
    const m = createMockFlightPlan({ latency: [0, 0], errorRate: 0 });
    return m;
  };
  it("Mag Filial: 5 pedidos vencidos somando R$ 276.610 e orçamentos fora da previsão (D4)", async () => {
    const m = mk();
    const p = await m.api.getPlan({ companyId: "mag-filial", month: "2026-11" });
    expect(p.summary.lateOrdersAmount).toBe(276_610);
    expect(p.summary.portfolio).toBe(289_680);
    expect(p.targetSource).toBe("company");
    expect(p.summary.target).toBe(700_000);
    expect(p.indicators.openQuotes.count).toBe(58);
    expect(p.indicators.conversion.status).toBe("forming");
    expect(p.indicators.conversion.rateCount).toBeNull();
    const weightedWithoutQuotes = p.summary.forecastProbable! - p.summary.realized;
    expect(weightedWithoutQuotes).toBe(p.summary.portfolioWeighted);
  });
  it("filtro Varejo: soma dos vendedores bate com o total e a meta é a do canal", async () => {
    const m = mk();
    const p = await m.api.getPlan({ companyId: "mag-filial", month: "2026-11", channel: "varejo" });
    expect(p.summary.target).toBe(600_000);
    expect(p.sellers.length).toBeGreaterThan(0);
    expect(p.reconciliation.difference).toBe(0);
  });
  it("Gestor vê só os 5 vendedores dele e não edita meta da empresa (D5)", async () => {
    const m = mk();
    m.setPersona("GESTOR");
    const p = await m.api.getPlan({ companyId: "mag-filial", month: "2026-11" });
    expect(p.sellers.map((s) => s.seller.id)).toHaveLength(5);
    await expect(
      m.api.saveTargets("mag-filial", "2026-11", [
        { scope: "company", channel: "varejo", level: "ACTIVE", amount: 1 },
      ]),
    ).rejects.toThrow("Admin e Diretoria");
  });
  it("Diretoria edita meta da empresa; prévia conta criadas, alteradas e removidas", async () => {
    const m = mk();
    m.setPersona("DIRETORIA");
    const prev = await m.api.previewTargets("mag-filial", "2026-11", [
      { scope: "company", channel: "varejo", level: "ACTIVE", amount: 620_000 },
      { scope: "seller", sellerId: "mag-filial-v14", level: "ACTIVE", amount: 5_000 },
      { scope: "seller", sellerId: "mag-filial-v11", level: "ACTIVE", amount: null },
    ]);
    expect([prev.created, prev.updated, prev.removed]).toEqual([1, 1, 1]);
  });
  it("Vendedor não lê vendedores de outros", async () => {
    const m = mk();
    m.setPersona("VENDEDOR");
    const p = await m.api.getPlan({ companyId: "mag-filial", month: "2026-11" });
    expect(p.sellers.map((s) => s.seller.id)).toEqual(["mag-filial-v02"]);
    await expect(m.api.getPlan({ companyId: "ergooffice", month: "2026-11" })).rejects.toThrow();
  });
  it("Ergo e Matriz sem meta; Matriz sem faturamento", async () => {
    const m = mk();
    expect((await m.api.getPlan({ companyId: "ergooffice", month: "2026-11" })).targetSource).toBe(
      "none",
    );
    expect(
      (await m.api.getPlan({ companyId: "mag-matriz", month: "2026-11" })).summary.realized,
    ).toBe(0);
  });
});

describe("grade de metas e resumo", () => {
  it("aceita 350.000,00 e 350000; recusa negativos e mais de 2 casas", () => {
    expect(parseMoneyInput("350.000,00")).toEqual({ ok: true, value: 350_000 });
    expect(parseMoneyInput("350000")).toEqual({ ok: true, value: 350_000 });
    expect(parseMoneyInput("")).toEqual({ ok: true, value: null });
    expect(parseMoneyInput("-1").ok).toBe(false);
    expect(parseMoneyInput("10,555").ok).toBe(false);
  });
  it("bloco colado do Excel vira linhas e colunas", () => {
    expect(parsePastedBlock("1.000\t2.000\r\n3000\t\n")).toEqual([
      ["1.000", "2.000"],
      ["3000", ""],
    ]);
  });
  it("resumo para WhatsApp", () => {
    expect(
      whatsappSummary({
        company: "Mag Filial",
        weekStart: "2026-11-16",
        realized: 412_000,
        attainment: 0.61,
        forecast: 598_000,
        atRisk: 3,
        openActions: 4,
        lateActions: 1,
      }),
    ).toBe(
      "Plano de Voo Mag Filial, semana de 16/11 (números do mês até hoje): realizado R$ 412.000 (61% da meta), previsão provável R$ 598.000, 3 vendedores em risco, 4 ações abertas, 1 atrasada.",
    );
  });
});
