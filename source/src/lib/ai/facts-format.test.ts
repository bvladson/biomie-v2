import { describe, expect, it } from "vitest";
import type { FlightPlan } from "@/flight-plan/api/contract";
import type { IntelOverview, Opportunity } from "@/estoque/api/intel-contract";
import { numbersOf, verifyAnswer } from "./verify";
import {
  breakdownFacts,
  comparisonFacts,
  headerLine,
  opportunityFacts,
  planFacts,
  revenueFacts,
  sellersFacts,
  stockFacts,
} from "./facts-format";

const seller = (
  name: string,
  realized: number,
  target: number | null,
  status: "ON_TRACK" | "RISK",
) =>
  ({
    seller: { id: name, companyId: "c", name, channel: "varejo", active: true },
    targets: { BASE: target, ACTIVE: target, CHALLENGE: null },
    metrics: {
      realized,
      target,
      attainment: target ? realized / target : null,
      status,
    },
    hasActivity: true,
    productivity: {
      revenuePerWorkday: null,
      invoicesPerWorkday: null,
      customers: 0,
      averageTicket: null,
    },
    openOrders: 0,
    lateOrders: 0,
    openQuotes: 0,
    commit: null,
    comparison: { previousMonthSameCut: 0, previousYearSameCut: 0, last3MonthsAvg: 0 },
  }) as unknown as FlightPlan["sellers"][number];

const PLAN = {
  summary: {
    target: 450000,
    realized: 412350,
    attainment: 0.916,
    idealToday: 430000,
    deviation: -17650,
    remainingGap: 37650,
    workdaysTotal: 25,
    workdaysElapsed: 20,
    workdaysRemaining: 5,
    currentDailyPace: 20617.5,
    requiredDailyPace: 7530,
    gapUnreachable: false,
    runRateForecast: 515437,
    forecastBase: null,
    forecastProbable: null,
    forecastCommit: null,
    portfolio: 80000,
    portfolioWeighted: 60000,
    lateOrdersAmount: 12000,
    gapCoverage: null,
    status: "ATTENTION",
  },
  indicators: {
    invoices: 37,
    averageTicket: 11144.59,
    customers: 214,
    newCustomers: 5,
    recurringCustomers: 180,
    openQuotes: { count: 9, amount: 52000, avgAgeDays: 12 },
    conversion: {
      status: "ready",
      since: "2026-08-01",
      quotes: 40,
      converted: 22,
      lost: 6,
      rateCount: 0.55,
      rateAmount: 0.6,
    },
    comparison: {
      previousMonthSameCut: 389120,
      previousYearSameCut: 350000,
      last3MonthsAvg: 395000,
    },
  },
  sellers: [
    seller("Ana", 158900, 150000, "ON_TRACK"),
    seller("Bruno", 90000, 120000, "RISK"),
    seller("Carla", 60000, 80000, "ON_TRACK"),
  ],
} as unknown as FlightPlan;

describe("pacotes de fatos do Plano de Voo", () => {
  it("ritmo: conclusões fechadas (meta ainda não batida, atrasado, situação)", () => {
    const lines = planFacts(PLAN);
    expect(lines.join("\n")).toContain("Meta batida: AINDA NÃO (faltam R$ 37.650)");
    expect(lines.join("\n")).toContain("atrasado R$ 17.650");
    expect(lines.join("\n")).toContain("Situação do plano: atenção");
    expect(lines.join("\n")).toContain("91,6%");
  });

  it("faturamento: variações já calculadas (o modelo não faz conta)", () => {
    const text = revenueFacts(PLAN).join("\n");
    expect(text).toContain("R$ 412.350");
    expect(text).toContain("variação: +6,0%");
    expect(text).toContain("novos: 5");
  });

  it("comparação inclui a média de 3 meses", () => {
    expect(comparisonFacts(PLAN).join("\n")).toContain("últimos 3 meses");
  });

  it("vendedores: ranking com meta, risco e participação", () => {
    const text = sellersFacts(PLAN).join("\n");
    expect(text).toContain("1º Ana: R$ 158.900");
    expect(text).toContain("Em risco de não bater a meta: Bruno");
    expect(text).toContain("38,5%");
  });

  it("uma resposta que copia os fatos passa na trava", () => {
    const lines = [headerLine("MAG Filial", "Novembro / 2026", "2026-11-10"), ...planFacts(PLAN)];
    const ok = verifyAnswer("Faturamos R$ 412.350, 91,6% da meta; faltam R$ 37.650.", lines);
    expect(ok.ok).toBe(true);
    expect(numbersOf(lines.join("\n")).length).toBeGreaterThan(8);
  });
});

describe("pacotes do estoque", () => {
  const OV = {
    capital: {
      total: 1503000,
      byCurve: {
        A: { products: 120, capital: 900000, unknownCost: 0 },
        B: { products: 300, capital: 400000, unknownCost: 1 },
        C: { products: 700, capital: 203000, unknownCost: 2 },
      },
      cdShare: 0.4,
      negative: { positions: 2, products: 2, value: -1500 },
    },
    states: [
      { state: "sem_venda_janela", products: 85, capital: 120000 },
      { state: "risco_ruptura", products: 14, capital: null },
    ],
    radar: [{ band: "365+", products: 31, capital: 76000, newProducts: 0 }],
    top: [
      {
        companyId: "c",
        omieProductId: "1",
        productId: null,
        sku: "SKU1",
        name: "Cadeira X",
        curve: "C",
        state: "possivel_obsolescencia",
        flags: [],
      },
    ],
  } as unknown as IntelOverview;

  it("estoque: capital, estados e parados antigos", () => {
    const text = stockFacts(OV).join("\n");
    expect(text).toContain("Capital em estoque (ao custo): R$ 1.503.000");
    expect(text).toContain("parados (sem venda na janela): 85");
    expect(text).toContain("mais de 365 dias: 31");
    expect(text).toContain("Cadeira X");
    expect(text).toContain("saldo negativo: 2");
  });

  it("oportunidades: movimento, destino e motivo", () => {
    const rows = [
      {
        sku: "SKU9",
        name: "Mesa Y",
        qty: 6,
        fromCompanyId: "a",
        fromCompanyName: "Matriz",
        fromOmie: "1",
        toCompanyId: "b",
        toCompanyName: "Filial",
        toOmie: "2",
        from: { available: 10, state: "sem_venda_janela", idleDays: 200, dailyDemand: 0 },
        to: { available: 1, pending: 0, dailyDemand: 0.5, coverageDays: 2 },
        valueAtCost: 4200,
        reason: "Parado na Matriz e girando na Filial",
        note: "",
        horizonDays: 30,
      },
    ] as unknown as Opportunity[];
    const text = opportunityFacts(rows, 4).join("\n");
    expect(text).toContain("Oportunidades de transferência hoje: 4");
    expect(text).toContain("mover 6 un. de Mesa Y de Matriz para Filial");
    expect(text).toContain("R$ 4.200");
  });

  it("ranking por dimensão", () => {
    const rows = [
      {
        key: "c1",
        label: "Cliente Grande",
        sub: null,
        category: null,
        revenue: 200000,
        units: 10,
        invoices: 4,
        customers: 1,
        lastDate: null,
        share: 0.5,
        previous: 150000,
        variation: 0.333,
        ticket: 50000,
      },
    ];
    const text = breakdownFacts("customer", rows as never, 400000).join("\n");
    expect(text).toContain("1º cliente Cliente Grande: R$ 200.000; 50,0% do total");
  });
});
