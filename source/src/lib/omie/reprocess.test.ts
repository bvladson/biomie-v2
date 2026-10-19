import { describe, expect, it, vi } from "vitest";
import { reprocessFromRaw } from "./reprocess.server";

const raw = (id: string, cfop: string) => ({
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

function admin(rows: ReturnType<typeof raw>[]) {
  const upserts: Record<string, unknown>[][] = [];
  const rpc = vi.fn(async (name: string) =>
    name === "get_legacy_classification_config"
      ? { data: {}, error: null }
      : { data: null, error: null },
  );
  return {
    upserts,
    rpc,
    client: {
      rpc,
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              range: async (from: number, to: number) => ({
                data: table.startsWith("raw_") ? rows.slice(from, to + 1) : [],
                error: null,
              }),
            }),
          }),
        }),
        upsert: async (values: Record<string, unknown>[]) => {
          upserts.push(values);
          return { error: null };
        },
      }),
    },
  };
}

describe("reprocess from RAW (no Omie calls)", () => {
  it("re-applies the current fiscal rules, promotes Gold and re-runs integrity checks", async () => {
    const db = admin([raw("1", "5.922"), raw("2", "5.116"), raw("3", "5.102")]);
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
  });
});
