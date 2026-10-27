import { describe, expect, it } from "vitest";
import { OmieError, type OmiePage } from "./omie-client";
import { StockRecordError, suppliersPageParams, toSupplierRow } from "./stock-adapter";
import type { StockPageReader, StockStepDeps } from "./stock.server";
import { runStockSuppliersStep } from "./stock-suppliers.server";

type Call = { name: string; args?: Record<string, unknown> | undefined };

const page = (
  records: Record<string, unknown>[],
  pageNumber: number,
  totalPages: number,
  total: number | null,
): OmiePage<unknown> => ({ page: pageNumber, totalPages, totalRecords: total, records });

const cadastro = (id: number, products: number[] = [501]) => ({
  nCodForn: id,
  cCodIntForn: "",
  cCpfCnpj: "12.345.678/0001-90",
  cRazaoSocial: `Fornecedor ${id} LTDA`,
  cNomeFantasia: `Fornecedor ${id}`,
  produtos: products.map((p) => ({
    nCodProd: p,
    cCodIntProd: "",
    cCodigo: `F-${p}`,
    cDescricao: "x",
  })),
});

function harness(options: {
  claim?: Record<string, unknown> | null;
  pages?: Record<number, OmiePage<unknown> | Error>;
  lease?: boolean;
  budget?: boolean;
}) {
  const calls: Call[] = [];
  const asked: Record<string, unknown>[] = [];
  let clock = 0;
  const reader: StockPageReader = {
    async listPage<T>(path: string, call: string, params: Record<string, unknown>) {
      clock += options.budget ? 20_000 : 1_000;
      asked.push({ path, call, ...params });
      const p = options.pages?.[Number(params["pagina"])];
      if (!p) throw new Error("página inesperada");
      if (p instanceof Error) throw p;
      return p as OmiePage<T>;
    },
  };
  const deps: StockStepDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "stock_worker_suppliers_claim")
        return {
          data:
            options.claim === undefined
              ? { id: "s1", companyId: "c1", nextPage: 1 }
              : options.claim,
          error: null,
        };
      if (name === "stock_worker_suppliers_save_page") {
        const n = Number(args?.["p_page"]);
        return {
          data: { restarted: false, done: n >= Number(args?.["p_pages_total"]) },
          error: null,
        };
      }
      if (name === "stock_worker_suppliers_finish")
        return { data: { links: 3, linksRemoved: 0, keptPrevious: false }, error: null };
      return { data: { ok: true }, error: null };
    },
    acquireLease: async () => (options.lease === false ? null : async () => {}),
    loadCredentials: async () => ({ appKey: "123456", appSecret: "segredo-super-secreto" }),
    client: () => reader,
    now: () => clock,
    log: () => {},
  };
  return { deps, calls, asked };
}

describe("supplier adapter (ListarProdutoFornecedor)", () => {
  it("keeps the Omie codes, names and the supplier's own product code, never the CPF/CNPJ", () => {
    const row = toSupplierRow(cadastro(9001, [501, 0, 502]));
    expect(row).toEqual({
      supplier_id: "9001",
      name: "Fornecedor 9001 LTDA",
      trade_name: "Fornecedor 9001",
      products: [
        { omie: "501", code: "F-501" },
        { omie: "502", code: "F-502" },
      ],
    });
    expect(JSON.stringify(row)).not.toContain("12.345.678");
    expect(toSupplierRow({ nCodForn: 0, produtos: [] })).toBeNull();
    expect(toSupplierRow({ cRazaoSocial: "Sem código" })).toBeNull();
    expect(toSupplierRow({ nCodForn: 7, produtos: "não é lista" })?.products).toEqual([]);
  });

  it("asks 10 per page (the documented maximum) and refuses absurd page numbers", () => {
    expect(suppliersPageParams(3)).toEqual({
      pagina: 3,
      registros_por_pagina: 10,
      apenas_importado_api: "N",
    });
    expect(() => suppliersPageParams(0)).toThrow(StockRecordError);
    expect(() => suppliersPageParams(2001)).toThrow(StockRecordError);
  });
});

describe("supplier import step (worker)", () => {
  it("does nothing without a queued import (switched off: no Omie call)", async () => {
    const h = harness({ claim: null });
    expect(await runStockSuppliersStep(h.deps)).toEqual({ jobId: null });
    expect(h.asked).toEqual([]);
  });

  it("reads only ListarProdutoFornecedor, saves every page and finishes", async () => {
    const h = harness({
      pages: {
        1: page([cadastro(9001, [501, 502]), { nCodForn: "x" }], 1, 2, 3),
        2: page([cadastro(9002)], 2, 2, 3),
      },
    });
    expect(await runStockSuppliersStep(h.deps)).toEqual({
      jobId: "s1",
      status: "SUCCESS",
      done: true,
    });
    expect(new Set(h.asked.map((a) => `${String(a["path"])}${String(a["call"])}`))).toEqual(
      new Set(["estoque/produtofornecedor/ListarProdutoFornecedor"]),
    );
    const saves = h.calls.filter((c) => c.name === "stock_worker_suppliers_save_page");
    expect(
      saves.map((c) => [
        c.args?.["p_page"],
        (c.args?.["p_rows"] as unknown[]).length,
        c.args?.["p_skipped"],
      ]),
    ).toEqual([
      [1, 1, 1],
      [2, 1, 0],
    ]);
    expect(h.calls.at(-1)?.name).toBe("stock_worker_suppliers_finish");
  });

  it("an empty list finishes on the first page (the database keeps the previous links)", async () => {
    const h = harness({ pages: { 1: page([], 1, 0, 0) } });
    expect((await runStockSuppliersStep(h.deps)).status).toBe("SUCCESS");
    expect(h.calls.find((c) => c.name === "stock_worker_suppliers_save_page")?.args).toMatchObject({
      p_pages_total: 1,
      p_records_total: 0,
    });
  });

  it("stops at the time budget and continues on the next cycle", async () => {
    const h = harness({
      budget: true,
      pages: { 1: page([cadastro(1)], 1, 3, 25), 2: page([cadastro(2)], 2, 3, 25) },
    });
    expect(await runStockSuppliersStep(h.deps)).toEqual({
      jobId: "s1",
      status: "RUNNING",
      done: false,
    });
    expect(h.asked).toHaveLength(1);
  });

  it("busy company key: waits for the lease without calling the Omie", async () => {
    const h = harness({ lease: false });
    expect((await runStockSuppliersStep(h.deps)).status).toBe("BUSY");
    expect(h.asked).toEqual([]);
  });

  it("an Omie block waits 30 min, a short retry never under 2 min; refused credentials end it without leaking", async () => {
    const blocked = harness({
      pages: { 1: new OmieError("rate_limit", "Consumo redundante detectado.", true) },
    });
    expect((await runStockSuppliersStep(blocked.deps)).status).toBe("RETRY");
    expect(blocked.calls.at(-1)?.args).toMatchObject({
      p_retry_after_seconds: 1800,
      p_final: false,
    });
    const quick = harness({ pages: { 1: new OmieError("server", "Erro", true, 5_000) } });
    await runStockSuppliersStep(quick.deps);
    expect(Number(quick.calls.at(-1)?.args?.["p_retry_after_seconds"])).toBeGreaterThanOrEqual(120);
    const refused = harness({
      pages: {
        1: new OmieError("auth", "Credenciais recusadas: app_secret segredo-super-secreto", false),
      },
    });
    expect((await runStockSuppliersStep(refused.deps)).status).toBe("FAILED");
    expect(String(refused.calls.at(-1)?.args?.["p_error"])).not.toContain("segredo-super-secreto");
  });
});
