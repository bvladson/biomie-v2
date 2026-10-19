import { describe, expect, it } from "vitest";
import {
  invoicesAdapter,
  mapItems,
  monthPartitions,
  ordersAdapter,
  receivablesAdapter,
  txPartitions,
  vendorsAdapter,
} from "./adapters";

describe("monthPartitions", () => {
  it("splits from/to into months, clipping edges", () => {
    expect(monthPartitions({ from: "2024-01-15", to: "2024-03-10" })).toEqual([
      { from: "2024-01-15", to: "2024-01-31" },
      { from: "2024-02-01", to: "2024-02-29" },
      { from: "2024-03-01", to: "2024-03-10" },
    ]);
  });
  it("crosses year boundary and handles a single day", () => {
    expect(monthPartitions({ from: "2024-12-31", to: "2025-01-01" })).toHaveLength(2);
    expect(monthPartitions({ from: "2024-05-05", to: "2024-05-05" })).toEqual([
      { from: "2024-05-05", to: "2024-05-05" },
    ]);
  });
});

describe("txPartitions", () => {
  it("adds one future partition to receivables (installments issued with future dates)", () => {
    const period = { from: "2026-09-15", to: "2026-10-19" };
    expect(txPartitions("receivables", period)).toEqual([
      { from: "2026-09-15", to: "2026-09-30" },
      { from: "2026-10-01", to: "2026-10-19" },
      { from: "2026-10-20", to: "2028-10-18" },
    ]);
  });
  it("keeps month partitions only for the other entities", () => {
    const period = { from: "2026-09-15", to: "2026-10-19" };
    for (const entity of ["invoices", "orders", "settlements"] as const)
      expect(txPartitions(entity, period)).toEqual(monthPartitions(period));
  });
});

describe("identity", () => {
  it("never uses name as identity: record without id is rejected", () => {
    expect(vendorsAdapter.toRaw({ nome: "João" })).toBeNull();
    expect(invoicesAdapter.toRaw({ ide: { nNF: "1" } })).toBeNull();
    expect(ordersAdapter.toRaw({ cabecalho: { numero_pedido: "9" } })).toBeNull();
    expect(receivablesAdapter.toRaw({ numero_documento: "X" })).toBeNull();
  });
  it("same payload yields the same external id (idempotent key)", () => {
    const p = { compl: { nIdNF: 77 }, ide: { nNF: "10", dEmi: "02/10/2026" } };
    expect(invoicesAdapter.toRaw(p)!.external_id).toBe(
      invoicesAdapter.toRaw({ ...p })!.external_id,
    );
  });
  it("item keys use source sequence and reject duplicates", () => {
    const items = mapItems([{ n: 3 }, { n: 1 }], (d, i) => ({
      item_sequence: Number(d["n"] ?? i + 1),
      product_external_id: null,
      description: null,
      quantity: 1,
      unit_price: 1,
      total: 1,
    }));
    expect(items.map((x) => x.item_sequence)).toEqual([3, 1]);
    expect(() =>
      mapItems([{}, {}], () => ({
        item_sequence: 1,
        product_external_id: null,
        description: null,
        quantity: 0,
        unit_price: 0,
        total: 0,
      })),
    ).toThrow();
  });
});

describe("invoice revenue contract", () => {
  it("keeps every amount component separately", () => {
    const c = invoicesAdapter.toCanonical({
      ide: { nNF: "123", dEmi: "02/10/2026", cStatus: "100" },
      compl: { nIdNF: 1, nCodVend: 5 },
      nfDestInt: { nCodCli: 9 },
      total: { ICMSTot: { vNF: 1150, vProd: 1000, vFrete: 100, vSeg: 20, vOutro: 40, vDesc: 10 } },
      det: [{ ide: { nItem: 1 }, prod: { vProd: 1000, qCom: 2 }, nfProdInt: { nCodProd: 44 } }],
    })!;
    expect(c.header).toMatchObject({
      gross_amount: 1150,
      goods_amount: 1000,
      freight_amount: 100,
      insurance_amount: 20,
      other_expenses_amount: 40,
      discount_amount: 10,
      competence_date: "2026-10-02",
      status: "authorized",
    });
    expect(c.items![0]).toMatchObject({ item_sequence: 1, product_external_id: "44", total: 1000 });
  });
  it("missing required date is not invented", () => {
    expect(invoicesAdapter.toCanonical({ ide: { nNF: "1" } })).toBeNull();
  });
});
