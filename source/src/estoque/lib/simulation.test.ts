import { describe, it, expect } from "vitest";
import { simulate, PRESETS, validateScenario, chartProjection, summarize } from "./simulation";
import { csvCell } from "./format";
import { createMockApi, makePositions } from "../dev/mock-api";
import type { SimulationItem, ScenarioInput } from "../api/contract";
const zero: ScenarioInput = { cuts: { A: 0, B: 0, C: 0, D: 0 }, discount: 0 };
const one = (patch: Partial<SimulationItem> = {}): SimulationItem => ({
  id: "1",
  sku: "1",
  name: "Produto",
  curve: "C",
  qty: 3,
  cost: 25.5,
  price: 50,
  ...patch,
});
const raw = [
  ["A", 180, 520, 899],
  ["A", 120, 310, 589],
  ["A", 150, 280, 529],
  ["B", 140, 395, 749],
  ["B", 100, 260, 499],
  ["B", 60, 620, 1179],
  ["C", 220, 155, 299],
  ["C", 80, 290, 549],
  ["C", 90, 480, 899],
  ["D", 160, 275, 519],
  ["D", 70, 380, 719],
  ["D", 80, 140, 269],
] as const;
const demo: SimulationItem[] = raw.map((r, i) => ({
  id: String(i),
  sku: String(i),
  name: "Produto",
  curve: r[0],
  qty: r[1],
  cost: r[2],
  price: r[3],
}));
describe("original calculation parity", () => {
  it("preserves original demo totals 473600, 1450, 12", () => {
    const r = simulate(demo, PRESETS.balanced);
    expect(r.totals.current).toBe(473600);
    expect(r.totals.units).toBe(1450);
    expect(r.totals.skus).toBe(12);
    expect(r.byCurve.A.current).toBe(172800);
    expect(r.byCurve.B.current).toBe(118500);
    expect(r.byCurve.C.current).toBe(100500);
    expect(r.byCurve.D.current).toBe(81800);
  });
  it("zero cuts preserve stock", () => {
    const r = simulate(demo, zero);
    expect(r.totals.removed).toBe(0);
    expect(r.totals.projected).toBe(473600);
    expect(r.totals.revenue).toBe(0);
  });
  it("100% cuts sell all positive classified units", () => {
    const r = simulate(demo, { cuts: { A: 100, B: 100, C: 100, D: 100 }, discount: 0 });
    expect(r.totals.projected).toBe(0);
    expect(r.totals.sold).toBe(1450);
    expect(r.totals.reduction).toBe(100);
  });
  it("floor by item, not by aggregate", () => {
    const r = simulate([one(), one({ id: "2" })], {
      cuts: { A: 0, B: 0, C: 50, D: 0 },
      discount: 0,
    });
    expect(r.totals.sold).toBe(2);
    expect(r.totals.removed).toBe(51);
    expect(r.totals.projected).toBe(102);
  });
  it("20% discount changes revenue only", () => {
    const a = simulate(demo, { ...PRESETS.balanced, discount: 0 }),
      b = simulate(demo, PRESETS.balanced);
    expect(b.totals.revenue).toBeCloseTo(a.totals.revenue * 0.8, 6);
    expect(b.totals.removed).toBe(a.totals.removed);
  });
  it("price zero marks partial revenue and still releases cost", () => {
    const r = simulate([one({ curve: "D", qty: 10, cost: 100, price: 0 })], {
      cuts: { A: 0, B: 0, C: 0, D: 100 },
      discount: 0,
    });
    expect(r.totals.removed).toBe(1000);
    expect(r.totals.missingPrice).toBe(1);
    expect(r.totals.revenue).toBe(0);
  });
  it("presets preserve exact values", () => {
    expect(PRESETS.conservative).toEqual({
      name: "Conservador",
      cuts: { A: 0, B: 10, C: 25, D: 50 },
      discount: 10,
    });
    expect(PRESETS.balanced).toEqual({
      name: "Equilibrado",
      cuts: { A: 0, B: 20, C: 50, D: 80 },
      discount: 20,
    });
    expect(PRESETS.intensive).toEqual({
      name: "Intensivo",
      cuts: { A: 0, B: 35, C: 75, D: 100 },
      discount: 30,
    });
    const rs = Object.values(PRESETS).map((p) => simulate(demo, p).totals.projected);
    expect(rs[0]).toBeGreaterThan(rs[1] ?? 0);
    expect(rs[1]).toBeGreaterThan(rs[2] ?? 0);
  });
  it("doubling quantities recalculates all presets", () => {
    for (const p of [PRESETS.balanced]) {
      const a = simulate(demo, p),
        b = simulate(
          demo.map((i) => ({ ...i, qty: i.qty * 2 })),
          p,
        );
      expect(b.totals.current).toBe(a.totals.current * 2);
      expect(b.totals.projected).toBeCloseTo(a.totals.projected * 2, 6);
    }
  });
  it("negative and unclassified stay in totals and never sell", () => {
    const r = simulate([one({ qty: -3.5 }), one({ id: "u", curve: "U", qty: 10 })], {
      cuts: { A: 100, B: 100, C: 100, D: 100 },
      discount: 70,
    });
    expect(r.totals.current).toBe(165.75);
    expect(r.totals.sold).toBe(0);
    expect(r.totals.projected).toBe(165.75);
    const ch = chartProjection([one({ qty: -3.5 }), one({ id: "u", curve: "U", qty: 10 })], zero);
    expect(ch.excludedCount).toBe(1);
    expect(ch.excludedValue).toBe(-89.25);
  });
  it("empty is finite", () => {
    for (const v of Object.values(simulate([], zero).totals)) expect(Number.isFinite(v)).toBe(true);
  });
  it("500 seeded samples conserve totals and rows", () => {
    let seed = 19026;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let k = 0; k < 500; k++) {
      const cuts = {
        A: Math.floor(rand() * 101),
        B: Math.floor(rand() * 101),
        C: Math.floor(rand() * 101),
        D: Math.floor(rand() * 101),
      };
      const items = Array.from({ length: 16 }, (_, j) =>
        one({
          id: String(j),
          curve: (["A", "B", "C", "D"] as const)[j % 4] ?? "A",
          qty: Math.floor(rand() * 500),
          cost: Math.round(rand() * 50000) / 100,
          price: Math.round(rand() * 100000) / 100,
        }),
      );
      const r = simulate(items, { cuts, discount: Math.floor(rand() * 71) });
      expect(r.totals.current).toBeCloseTo(r.totals.projected + r.totals.removed, 5);
      expect(r.totals.sold).toBeLessThanOrEqual(r.totals.units);
      for (const row of r.rows) {
        expect(Number.isInteger(row.sold)).toBe(true);
        expect(row.sold).toBeLessThanOrEqual(row.qty);
        expect(row.current).toBeCloseTo(row.projected + row.removed, 5);
      }
    }
  });
  it("cuts bounded at 100, discount bounded at 70 and integers", () => {
    expect(validateScenario({ ...zero, discount: 70 })).toBe(true);
    expect(validateScenario({ ...zero, discount: 71 })).toBe(false);
    expect(validateScenario({ ...zero, cuts: { ...zero.cuts, A: 101 } })).toBe(false);
    expect(validateScenario({ ...zero, discount: 1.5 })).toBe(false);
  });
  it("reserved and pending do not deduct physical", () => {
    const p = makePositions(1);
    const r = summarize(p, true);
    expect(r.totals.units).toBe(p[0]?.physicalQty);
    p.forEach((x) => {
      x.reservedQty = 1000;
      x.pendingQty = 2000;
    });
    expect(summarize(p, true).totals.units).toBe(r.totals.units);
  });
  it("20000 item simulation under 100ms after warmup", () => {
    const items = Array.from({ length: 20000 }, (_, i) => one({ id: String(i) }));
    simulate(items, PRESETS.balanced);
    const start = performance.now();
    const r = simulate(items, PRESETS.balanced);
    const ms = performance.now() - start;
    console.log("20000 simulation ms", ms.toFixed(2));
    expect(r.rows.length).toBe(20000);
    expect(ms).toBeLessThan(100);
  });
});
describe("StockApi contract boundaries", () => {
  it("seller redaction and direct simulation denial", async () => {
    const { api } = createMockApi("VENDEDOR", 300, 0);
    const r = await api.positions({ companyId: "all", page: 0 });
    expect(r.rows).toHaveLength(100);
    expect(
      r.rows.every((p) => p.unitCost === null && p.costValue === null && p.salePrice === null),
    ).toBe(true);
    expect((await api.overview("all")).totals.costValue).toBeNull();
    await expect(api.simulationBase("all")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("viewer cannot read", async () => {
    await expect(createMockApi("VIEWER", 300, 0).api.overview("all")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("only permitted companies accepted", async () => {
    await expect(
      createMockApi("SUPER_ADMIN", 300, 0).api.positions({ companyId: "unknown", page: 0 }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("300 demo positions, 5 companies, 100/page", async () => {
    const { api } = createMockApi("SUPER_ADMIN", 300, 0);
    const r = await api.overview("all");
    expect(r.totals.positions).toBe(300);
    expect(r.readings).toHaveLength(5);
    expect((await api.positions({ companyId: "all", page: 2 })).rows).toHaveLength(100);
  });
  it("curve change covers product at all 3 locations within one company only", async () => {
    const { api } = createMockApi("SUPER_ADMIN", 300, 0);
    // Curva manual exige justificativa (0043); "AUTO" volta para a automática sem justificativa.
    await expect(api.setCurve({ positionIds: ["uni-p0-l0-0"], curve: "D" })).rejects.toMatchObject({
      code: "invalid",
    });
    const r = await api.setCurve({
      positionIds: ["uni-p0-l0-0"],
      curve: "D",
      reason: "Produto parado no depósito há meses",
    });
    expect(r.updated).toBe(3);
    const p = await api.positions({ companyId: "uni", productId: "uni-p0", page: 0 });
    expect(p.rows.every((x) => x.curve === "D")).toBe(true);
    expect(
      (await api.positions({ companyId: "filial", productId: "filial-p0", page: 0 })).rows.every(
        (x) => x.curve === "A",
      ),
    ).toBe(true);
    // Visão por produto: "empresa:produto:*" vale para todos os locais.
    const back = await api.setCurve({ positionIds: ["uni:10000:*"], curve: "AUTO" });
    expect(back.updated).toBe(3);
  });
  it("scenario limit 5; names max 60", async () => {
    const { api } = createMockApi("SUPER_ADMIN", 300, 0);
    for (let i = 0; i < 5; i++) await api.saveScenario({ ...zero, name: "Cenário " + i });
    await expect(api.saveScenario({ ...zero, name: "Sexto" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(api.saveScenario({ ...zero, name: "x".repeat(61) })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await api.listScenarios()).toHaveLength(5);
  });
  it("refresh cooldown 60 seconds", async () => {
    const { api } = createMockApi("SUPER_ADMIN", 300, 0);
    expect((await api.requestRefresh("uni")).queued).toBe(true);
    expect((await api.requestRefresh("uni")).queued).toBe(false);
  });
  it("CSV exports every filtered row not only first page", async () => {
    const { api } = createMockApi("SUPER_ADMIN", 300, 0);
    const r = await api.exportCsv({ kind: "positions", query: { companyId: "all" } });
    expect(r.csv.split("\r\n")).toHaveLength(301);
    expect(r.csv).toContain(";");
  });
  it("CSV protects formulas and quoting", () => {
    for (const s of ["=1", "+2", "-3", "−4", "@a", "  =1"]) expect(csvCell(s)).toContain("'");
    expect(csvCell('a"b;c')).toBe('"a""b;c"');
  });
});
