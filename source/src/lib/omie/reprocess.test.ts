import { describe, expect, it, vi } from "vitest";
import { mergePeriods, reprocessFromRaw } from "./reprocess.server";

type Row = Record<string, unknown>;

const invoice = (id: string, cfop: string) => ({
  id: `raw-${id}`,
  external_id: id,
  payload: {
    compl: { nIdNF: id, cChaveNFe: "1".repeat(44) },
    ide: { nNF: id, dEmi: "10/07/2026", cDeneg: "N", tpAmb: "1", tpNF: "1" },
    nfDestInt: { nCodCli: 1 },
    titulos: [{ nCodVendedor: 100 }],
    total: { ICMSTot: { vNF: 100, vProd: 100, vFrete: 0, vSeg: 0, vOutro: 0 } },
    det: [{ prod: { CFOP: cfop, vProd: 100 }, nfProdInt: { nCodProd: 9 } }],
  },
});

const settlement = (id: string, detalhes: Row, resumo: Row) => ({
  id: `raw-${id}`,
  external_id: id,
  payload: {
    detalhes: {
      nCodBaixa: id,
      nCodTitulo: 8,
      dDtPagamento: "04/08/2026",
      cNatureza: "R",
      cStatus: "RECEBIDO",
      ...detalhes,
    },
    resumo,
  },
});

/** Minimal PostgREST-like builder: filters are ignored, results come per table. */
function admin(raw: Row[], runs: { running?: Row[]; proven?: Row[] } = {}) {
  const upserts: Row[][] = [];
  const inserts: Row[][] = [];
  const rpc = vi.fn(async (name: string) =>
    name === "get_legacy_classification_config"
      ? { data: {}, error: null }
      : { data: null, error: null },
  );
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const result = () => {
      if (table !== "integration_sync_runs") return { data: [], error: null };
      return {
        data: filters["status"] === "RUNNING" ? (runs.running ?? []) : (runs.proven ?? []),
        error: null,
      };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      range: async (lo: number, hi: number) => ({
        data: table.startsWith("raw_") ? raw.slice(lo, hi + 1) : [],
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) => resolve(result()),
      upsert: async (values: Row[]) => {
        upserts.push(values);
        return { error: null };
      },
      insert: async (values: Row[]) => {
        inserts.push(values);
        return { error: null };
      },
    };
    return chain;
  };
  return { upserts, inserts, rpc, client: { rpc, from } };
}

describe("reprocess from RAW (no Omie calls)", () => {
  it("re-applies the current fiscal rules, promotes Gold and re-runs integrity checks", async () => {
    const db = admin([invoice("1", "5.922"), invoice("2", "5.116"), invoice("3", "5.102")], {
      proven: [{ period_from: "2026-01-01", period_to: "2026-10-19" }],
    });
    const result = await reprocessFromRaw(db.client as never, "company-1", "invoices", 2);
    expect(result).toMatchObject({ read: 3, updated: 3, skipped: 0, promoted: true });
    const scopes = Object.fromEntries(
      db.upserts.flat().map((row) => [row["external_id"], row["operation_scope"]]),
    );
    expect(scopes).toEqual({ "1": "commercial", "2": "remittance", "3": "commercial" });
    expect(db.rpc).toHaveBeenCalledWith("promote_omie_gold", {
      p_company: "company-1",
      p_entity: "invoices",
    });
    expect(db.rpc).toHaveBeenCalledWith("run_integrity_checks", { p_company: "company-1" });
    expect(db.rpc).toHaveBeenCalledWith("mark_raw_processed", {
      p_entity: "invoices",
      p_company: "company-1",
      p_ids: ["raw-1", "raw-2"],
      p_state: "CANONICAL",
    });
  });

  it("turns discount-only and batch settlements into Canonical and certifies the proven period", async () => {
    const db = admin(
      [
        // Settled only by discount: no bank movement, nothing paid in cash.
        settlement("10", { nDesconto: 18000 }, { nValPago: 0 }),
        // One deposit of 55,830.95 shared by three titles: this title received 8,002.75.
        settlement("11", { nValorMovCC: 55830.95, nCodMovCC: 7 }, { nValPago: 8002.75 }),
      ],
      { proven: [{ period_from: "2026-01-01", period_to: "2026-10-19" }] },
    );
    const result = await reprocessFromRaw(db.client as never, "company-1", "settlements");
    expect(result).toMatchObject({ read: 2, updated: 2, skipped: 0, promoted: true });
    const rows = Object.fromEntries(db.upserts.flat().map((row) => [row["external_id"], row]));
    expect(rows["10"]).toMatchObject({ amount: 0, discount_amount: 18000 });
    expect(rows["11"]).toMatchObject({ amount: 8002.75, discount_amount: 0 });
    expect(db.rpc).toHaveBeenCalledWith("promote_omie_gold", {
      p_company: "company-1",
      p_entity: "receivables",
    });
    expect(db.inserts.flat()).toEqual([
      expect.objectContaining({
        entity: "settlements",
        mode: "REPROCESS",
        status: "SUCCESS",
        period_from: "2026-01-01",
        period_to: "2026-10-19",
        raw_complete: true,
        canonical_complete: true,
        gold_complete: true,
        failed: 0,
      }),
    ]);
  });

  it("does not certify Canonical when some RAW row still cannot be converted", async () => {
    const db = admin([settlement("12", {}, {})], {
      proven: [{ period_from: "2026-01-01", period_to: "2026-10-19" }],
    });
    const result = await reprocessFromRaw(db.client as never, "company-1", "settlements");
    expect(result).toMatchObject({ read: 1, updated: 0, skipped: 1 });
    expect(db.inserts.flat()[0]).toMatchObject({
      status: "WARNING",
      canonical_complete: false,
      failed: 1,
    });
  });

  it("records no run when no RAW period was ever proven complete", async () => {
    const db = admin([invoice("1", "5.102")]);
    const result = await reprocessFromRaw(db.client as never, "company-1", "invoices");
    expect(result.periods).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("refuses to run while a sync of the same entity is running", async () => {
    const db = admin([invoice("1", "5.102")], { running: [{ id: "run-1" }] });
    await expect(reprocessFromRaw(db.client as never, "company-1", "invoices")).rejects.toThrow(
      /em andamento/,
    );
    expect(db.upserts).toEqual([]);
  });

  it("merges overlapping and adjacent proven periods, keeping real gaps", () => {
    expect(
      mergePeriods([
        { from: "2026-03-01", to: "2026-03-31" },
        { from: "2026-01-01", to: "2026-01-31" },
        { from: "2026-02-01", to: "2026-02-28" },
        { from: "2026-05-01", to: "2026-05-31" },
      ]),
    ).toEqual([
      { from: "2026-01-01", to: "2026-03-31" },
      { from: "2026-05-01", to: "2026-05-31" },
    ]);
  });
});
