import { describe, expect, it } from "vitest";
import { OmieError, type OmiePage } from "./omie-client";
import {
  MAX_STOCK_PAGES,
  StockRecordError,
  checkStockTotal,
  movementsPageParams,
  stockPageParams,
  toIsoDate,
  toLocationEntry,
  toMovementRow,
  toStockRow,
} from "./stock-adapter";
import {
  failureDetail,
  runStockStep,
  safeStockMessage,
  type StockPageReader,
  type StockStepDeps,
} from "./stock.server";
import { runStockMovementsStep } from "./stock-movements.server";

describe("stock adapter (ListarPosEstoque)", () => {
  it("maps a position like the original project: físico × CMC, reservado e pendente à parte", () => {
    const row = toStockRow({
      nCodProd: 123456,
      codigo_local_estoque: 4,
      cCodigo: "MAG-001",
      cDescricao: "Cadeira York presidente",
      fisico: 10,
      nSaldo: 8,
      reservado: 2,
      nPendente: 3,
      estoque_minimo: 5,
      nCMC: 520.5,
      nPrecoUnitario: 899,
    });
    expect(row).toEqual({
      omie_product_id: "123456",
      location_code: "4",
      sku: "MAG-001",
      name: "Cadeira York presidente",
      physical_qty: 10,
      balance_qty: 8,
      reserved_qty: 2,
      pending_qty: 3,
      min_qty: 5,
      unit_cost: 520.5,
      sale_price: 899,
    });
  });

  it("falls back to nSaldo, keeps negative balances and fills optional fields", () => {
    const row = toStockRow({ nCodProd: "77", nSaldo: -3.5, nCMC: "12.25" });
    expect(row.physical_qty).toBe(-3.5);
    expect(row.location_code).toBe("total");
    expect(row.sku).toBe("77");
    expect(row.name).toBe("77");
    expect(row.reserved_qty).toBe(0);
    expect(row.pending_qty).toBe(0);
    expect(row.min_qty).toBeNull();
    expect(row.sale_price).toBe(0);
    expect(row.unit_cost).toBe(12.25);
  });

  it("rejects records that cannot be stored", () => {
    expect(() => toStockRow({ fisico: 1, nCMC: 1 })).toThrow(StockRecordError);
    expect(() => toStockRow({ nCodProd: 1, fisico: 1, nCMC: -1 })).toThrow(StockRecordError);
    expect(() => toStockRow({ nCodProd: 1, fisico: "abc", nCMC: 1 })).toThrow(StockRecordError);
    expect(() => toStockRow({ nCodProd: 1, fisico: 1 })).toThrow(StockRecordError);
    expect(() =>
      toStockRow({ nCodProd: 1, fisico: 1, nCMC: 1, codigo_local_estoque: "x" }),
    ).toThrow(StockRecordError);
  });

  it("asks for every location and product with movement history, 100 per page", () => {
    expect(stockPageParams(3, "21/10/2026")).toEqual({
      nPagina: 3,
      nRegPorPagina: 100,
      dDataPosicao: "21/10/2026",
      cExibeTodos: "S",
      lista_local_estoque: "TODOS",
    });
    expect(() => stockPageParams(1, "2026-10-21")).toThrow(StockRecordError);
  });

  it("allows 20.000 positions at the 50 per page the Omie really returns", () => {
    // MAG Filial em 22/10/2026: 11.088 posições em 222 páginas de 50.
    expect(MAX_STOCK_PAGES).toBe(400);
    expect(stockPageParams(222, "22/10/2026")["nPagina"]).toBe(222);
    expect(stockPageParams(400, "22/10/2026")["nPagina"]).toBe(400);
    expect(() => stockPageParams(401, "22/10/2026")).toThrow(/20.000/);
    expect(() => checkStockTotal(11_088)).not.toThrow();
    expect(() => checkStockTotal(20_000)).not.toThrow();
    expect(() => checkStockTotal(20_001)).toThrow(/20\.001 posições/);
  });

  it("maps stock locations with name and sale availability", () => {
    expect(
      toLocationEntry({
        codigo_local_estoque: 9,
        codigo: "DEP",
        descricao: "Depósito central",
        tipo: "1",
        padrao: "S",
        inativo: "N",
        dispVenda: "S",
      }),
    ).toEqual([
      "9",
      {
        name: "Depósito central",
        code: "DEP",
        type: "1",
        defaultLocation: true,
        forSale: true,
        inactive: false,
      },
    ]);
    expect(toLocationEntry({ descricao: "sem código" })).toBeNull();
  });
});

type Call = { name: string; args: Record<string, unknown> | undefined };

function page(
  records: Record<string, unknown>[],
  pageNumber: number,
  totalPages: number,
  total: number | null,
): OmiePage<unknown> {
  return { page: pageNumber, totalPages, totalRecords: total, records };
}

const position = (id: number, local = 1) => ({
  nCodProd: id,
  codigo_local_estoque: local,
  cCodigo: `SKU-${id}`,
  cDescricao: `Produto ${id}`,
  fisico: id,
  nCMC: 10,
  nPrecoUnitario: 20,
});

function harness(options: {
  claim?: Record<string, unknown> | null;
  pages?: Record<number, OmiePage<unknown> | Error>;
  locations?: OmiePage<unknown> | Error;
  saveResult?: (page: number) => Record<string, unknown>;
  lease?: boolean;
  budget?: number;
}) {
  const calls: Call[] = [];
  let clock = 0;
  let released = false;
  const reader: StockPageReader = {
    async listPage<T>(path: string, _call: string, params: Record<string, unknown>) {
      clock += 1_000;
      if (path === "estoque/local/") {
        const l = options.locations ?? page([], 1, 1, 0);
        if (l instanceof Error) throw l;
        return l as OmiePage<T>;
      }
      const p = options.pages?.[Number(params["nPagina"])];
      if (!p) throw new Error("página inesperada");
      if (p instanceof Error) throw p;
      return p as OmiePage<T>;
    },
  };
  const deps: StockStepDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "stock_worker_claim")
        return {
          data:
            options.claim === undefined
              ? {
                  id: "r1",
                  companyId: "c1",
                  positionDate: "21/10/2026",
                  nextPage: 1,
                  locationsLoaded: false,
                }
              : options.claim,
          error: null,
        };
      if (name === "stock_worker_save_page") {
        const n = Number(args?.["p_page"]);
        return {
          data: options.saveResult?.(n) ?? {
            restarted: false,
            done: n >= Number(args?.["p_pages_total"]),
          },
          error: null,
        };
      }
      if (name === "stock_worker_finish")
        return { data: { published: true, positions: 3 }, error: null };
      return { data: { ok: true }, error: null };
    },
    acquireLease: async () =>
      options.lease === false
        ? null
        : async () => {
            released = true;
          },
    loadCredentials: async () => ({ appKey: "123456", appSecret: "segredo-super-secreto" }),
    client: () => reader,
    now: () => clock,
    log: () => {},
  };
  return { deps, calls, released: () => released, budget: options.budget ?? 15_000 };
}

describe("stock reading step (worker)", () => {
  it("does nothing when the queue is empty", async () => {
    const h = harness({ claim: null });
    expect(await runStockStep(h.deps, h.budget)).toEqual({ jobId: null });
    expect(h.calls.map((c) => c.name)).toEqual(["stock_worker_claim"]);
  });

  it("reads locations and every page, then asks the database to publish", async () => {
    const h = harness({
      locations: page([{ codigo_local_estoque: 1, descricao: "Depósito" }], 1, 1, 1),
      pages: {
        1: page([position(1), position(2)], 1, 2, 3),
        2: page([position(3)], 2, 2, 3),
      },
    });
    const result = await runStockStep(h.deps, h.budget);
    expect(result).toEqual({ jobId: "r1", status: "SUCCESS", done: true });
    expect(h.calls.map((c) => c.name)).toEqual([
      "stock_worker_claim",
      "stock_worker_save_locations",
      "stock_worker_save_page",
      "stock_worker_save_page",
      "stock_worker_finish",
      // Leitura publicada: a curva automática da empresa é recalculada na hora (0043).
      "stock_worker_refresh_curves",
    ]);
    expect(h.calls.at(-1)?.args).toEqual({ p_company: "c1" });
    expect(h.calls[1]?.args?.["p_locations"]).toEqual({
      "1": expect.objectContaining({ name: "Depósito" }),
    });
    expect(h.calls[2]?.args).toMatchObject({ p_page: 1, p_pages_total: 2, p_records_total: 3 });
    expect((h.calls[3]?.args?.["p_rows"] as unknown[]).length).toBe(1);
    expect(h.released()).toBe(true);
  });

  it("publishes an empty stock as a complete reading", async () => {
    const h = harness({ pages: { 1: page([], 1, 0, 0) } });
    const result = await runStockStep(h.deps, h.budget);
    expect(result.status).toBe("SUCCESS");
    expect(h.calls.find((c) => c.name === "stock_worker_save_page")?.args).toMatchObject({
      p_page: 1,
      p_pages_total: 1,
      p_records_total: 0,
    });
  });

  it("continues from the claimed page and stops at the time budget", async () => {
    const h = harness({
      claim: {
        id: "r1",
        companyId: "c1",
        positionDate: "21/10/2026",
        nextPage: 2,
        locationsLoaded: true,
      },
      pages: {
        2: page([position(1)], 2, 5, 5),
        3: page([position(2)], 3, 5, 5),
        4: page([position(3)], 4, 5, 5),
      },
      budget: 2_000,
    });
    const result = await runStockStep(h.deps, h.budget);
    expect(result).toEqual({ jobId: "r1", status: "RUNNING", done: false });
    const pages = h.calls
      .filter((c) => c.name === "stock_worker_save_page")
      .map((c) => c.args?.["p_page"]);
    expect(pages).toEqual([2, 3]);
    expect(h.calls.some((c) => c.name === "stock_worker_save_locations")).toBe(false);
  });

  it("puts the reading back in the queue on an Omie block, waiting 30 minutes", async () => {
    const h = harness({
      pages: { 1: new OmieError("rate_limit", "Consumo redundante detectado.", true) },
    });
    const result = await runStockStep(h.deps, h.budget);
    expect(result).toEqual({ jobId: "r1", status: "RETRY", done: false });
    expect(h.calls.at(-1)).toEqual({
      name: "stock_worker_fail",
      args: {
        p_reading: "r1",
        p_error: "Consumo redundante detectado.",
        p_retry_after_seconds: 1800,
        p_final: false,
      },
    });
    expect(h.released()).toBe(true);
  });

  it("ends the reading on refused credentials without leaking them", async () => {
    const h = harness({
      pages: {
        1: new OmieError(
          "auth",
          "Credenciais recusadas pelo Omie: app_secret segredo-super-secreto",
          false,
        ),
      },
    });
    const result = await runStockStep(h.deps, h.budget);
    expect(result).toEqual({ jobId: "r1", status: "FAILED", done: true });
    const fail = h.calls.at(-1);
    expect(fail?.args?.["p_final"]).toBe(true);
    expect(String(fail?.args?.["p_error"])).not.toContain("segredo-super-secreto");
  });

  it("ends the reading on a record that cannot be stored", async () => {
    const h = harness({ pages: { 1: page([{ nCodProd: 1, fisico: 1, nCMC: -5 }], 1, 1, 1) } });
    const result = await runStockStep(h.deps, h.budget);
    expect(result.status).toBe("FAILED");
    expect(h.calls.at(-1)?.args?.["p_error"]).toContain("custo médio contábil");
  });

  it("ends on the first page when the Omie declares more than 20.000 positions", async () => {
    const h = harness({ pages: { 1: page([position(1)], 1, 401, 20_001) } });
    const result = await runStockStep(h.deps, h.budget);
    expect(result).toEqual({ jobId: "r1", status: "FAILED", done: true });
    expect(h.calls.some((c) => c.name === "stock_worker_save_page")).toBe(false);
    expect(h.calls.at(-1)).toMatchObject({
      name: "stock_worker_fail",
      args: { p_final: true, p_error: expect.stringContaining("acima do limite de 20.000") },
    });
  });

  it("reads past page 200 (MAG Filial: 222 pages of 50)", async () => {
    const h = harness({
      claim: {
        id: "r1",
        companyId: "c1",
        positionDate: "22/10/2026",
        nextPage: 221,
        locationsLoaded: true,
      },
      pages: {
        221: page([position(1)], 221, 222, 11_088),
        222: page([position(2)], 222, 222, 11_088),
      },
    });
    expect(await runStockStep(h.deps, h.budget)).toEqual({
      jobId: "r1",
      status: "SUCCESS",
      done: true,
    });
  });

  it("keeps reading when location names are not available", async () => {
    const h = harness({
      locations: new OmieError("client", "Omie recusou a requisição: método indisponível", false),
      pages: { 1: page([position(1)], 1, 1, 1) },
    });
    expect((await runStockStep(h.deps, h.budget)).status).toBe("SUCCESS");
    expect(h.calls[1]).toEqual({
      name: "stock_worker_save_locations",
      args: { p_reading: "r1", p_locations: {} },
    });
  });

  it("stops when the database restarts the reading (total changed in the middle)", async () => {
    const h = harness({
      pages: { 1: page([position(1)], 1, 2, 2), 2: page([position(2)], 2, 2, 2) },
      saveResult: () => ({ restarted: true }),
    });
    expect(await runStockStep(h.deps, h.budget)).toEqual({
      jobId: "r1",
      status: "RESTARTED",
      done: false,
    });
    expect(h.calls.filter((c) => c.name === "stock_worker_save_page")).toHaveLength(1);
  });

  it("waits when another process holds the company lease", async () => {
    const h = harness({ lease: false });
    expect(await runStockStep(h.deps, h.budget)).toEqual({
      jobId: "r1",
      status: "BUSY",
      done: false,
    });
    expect(h.calls.map((c) => c.name)).toEqual(["stock_worker_claim"]);
  });
});

describe("stock movements adapter (ListarMovimentoEstoque)", () => {
  it("maps a movement and normalizes date, kind and operation", () => {
    expect(
      toMovementRow({
        idMov: 987654321,
        dtMov: "05/10/2026",
        tipo: "Saída",
        operacao: "11",
        desOrigem: "Venda de Produto",
        cancelamento: "N",
        devolucao: "N",
        idProd: 123456,
        codigo_local_estoque: 4,
        qtde: 2,
        cmc: 50.5,
        valor: 101,
        numDoc: "000123",
      }),
    ).toEqual({
      movement_id: 987654321,
      moved_on: "2026-10-05",
      kind: "saida",
      operation: "11",
      origin: "Venda de Produto",
      canceled: false,
      is_return: false,
      omie_product_id: "123456",
      location_code: "4",
      qty: 2,
      unit_cost: 50.5,
      value: 101,
      document: "000123",
    });
    const entry = toMovementRow({
      idMov: "5",
      dtMov: "2026-01-02",
      tipo: "entrada",
      operacao: "0",
      idProd: "7",
      cancelamento: "S",
    });
    expect(entry).toMatchObject({
      kind: "entrada",
      operation: "00",
      canceled: true,
      location_code: null,
      qty: null,
    });
  });

  it("skips records that cannot be stored instead of failing the whole period", () => {
    expect(toMovementRow({ dtMov: "05/10/2026", tipo: "entrada", idProd: 1 })).toBeNull();
    expect(toMovementRow({ idMov: 1, dtMov: "ontem", tipo: "entrada", idProd: 1 })).toBeNull();
    expect(
      toMovementRow({ idMov: 1, dtMov: "05/10/2026", tipo: "transferência", idProd: 1 }),
    ).toBeNull();
    expect(toMovementRow({ idMov: 1, dtMov: "05/10/2026", tipo: "entrada", idProd: 0 })).toBeNull();
    expect(toIsoDate("31/12/2025")).toBe("2025-12-31");
  });

  it("asks for every location in a date range, 100 per page", () => {
    expect(movementsPageParams(2, "01/09/2026", "30/09/2026")).toEqual({
      nPagina: 2,
      nRegPorPagina: 100,
      dDtInicial: "01/09/2026",
      dDtFinal: "30/09/2026",
      lista_local_estoque: "TODOS",
    });
    expect(() => movementsPageParams(1, "2026-09-01", "30/09/2026")).toThrow(StockRecordError);
  });
});

function movementsHarness(options: {
  claim?: Record<string, unknown> | null;
  pages?: Record<number, OmiePage<unknown> | Error>;
  lastOfCompany?: boolean;
}) {
  const calls: Call[] = [];
  let clock = 0;
  const reader: StockPageReader = {
    async listPage<T>(_path: string, _call: string, params: Record<string, unknown>) {
      clock += 1_000;
      const p = options.pages?.[Number(params["nPagina"])];
      if (!p) throw new Error("página inesperada");
      if (p instanceof Error) throw p;
      return p as OmiePage<T>;
    },
  };
  const deps: StockStepDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "stock_worker_movements_claim")
        return {
          data:
            options.claim === undefined
              ? { id: "m1", companyId: "c1", from: "01/09/2026", to: "30/09/2026", nextPage: 1 }
              : options.claim,
          error: null,
        };
      if (name === "stock_worker_movements_save_page") {
        const n = Number(args?.["p_page"]);
        return {
          data: { restarted: false, done: n >= Number(args?.["p_pages_total"]) },
          error: null,
        };
      }
      if (name === "stock_worker_movements_finish")
        return { data: { records: 3, lastOfCompany: options.lastOfCompany ?? true }, error: null };
      if (name === "stock_worker_refresh_curves") return { data: { status: "ok" }, error: null };
      return { data: { ok: true }, error: null };
    },
    acquireLease: async () => async () => {},
    loadCredentials: async () => ({ appKey: "123456", appSecret: "segredo-super-secreto" }),
    client: () => reader,
    now: () => clock,
    log: () => {},
  };
  return { deps, calls };
}

const movement = (id: number, kind = "entrada") => ({
  idMov: id,
  dtMov: "10/09/2026",
  tipo: kind,
  operacao: "21",
  idProd: 500 + id,
});

describe("stock movements step (worker)", () => {
  it("does nothing without queued periods (movements switched off)", async () => {
    const h = movementsHarness({ claim: null });
    expect(await runStockMovementsStep(h.deps)).toEqual({ jobId: null });
  });

  it("saves every page, counts skipped records and recalculates the curves at the end", async () => {
    const h = movementsHarness({
      pages: {
        1: page([movement(1), { idMov: 2, tipo: "entrada" }], 1, 2, 3),
        2: page([movement(3, "saida")], 2, 2, 3),
      },
    });
    expect(await runStockMovementsStep(h.deps)).toEqual({
      jobId: "m1",
      status: "SUCCESS",
      done: true,
    });
    const saves = h.calls.filter((c) => c.name === "stock_worker_movements_save_page");
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
    expect(h.calls.slice(-2).map((c) => c.name)).toEqual([
      "stock_worker_movements_finish",
      "stock_worker_refresh_curves",
    ]);
  });

  it("only recalculates when the last period of the company is done", async () => {
    const h = movementsHarness({
      pages: { 1: page([movement(1)], 1, 1, 1) },
      lastOfCompany: false,
    });
    await runStockMovementsStep(h.deps);
    expect(h.calls.some((c) => c.name === "stock_worker_refresh_curves")).toBe(false);
  });

  it("an empty period finishes on the first page", async () => {
    const h = movementsHarness({ pages: { 1: page([], 1, 0, 0) } });
    expect((await runStockMovementsStep(h.deps)).status).toBe("SUCCESS");
    expect(h.calls.find((c) => c.name === "stock_worker_movements_save_page")?.args).toMatchObject({
      p_pages_total: 1,
      p_records_total: 0,
    });
  });

  it("an Omie block waits 30 minutes; refused credentials end the period without leaking them", async () => {
    const blocked = movementsHarness({
      pages: { 1: new OmieError("rate_limit", "Consumo redundante detectado.", true) },
    });
    expect((await runStockMovementsStep(blocked.deps)).status).toBe("RETRY");
    expect(blocked.calls.at(-1)?.args).toMatchObject({
      p_retry_after_seconds: 1800,
      p_final: false,
    });
    const refused = movementsHarness({
      pages: {
        1: new OmieError("auth", "Credenciais recusadas: app_secret segredo-super-secreto", false),
      },
    });
    expect((await runStockMovementsStep(refused.deps)).status).toBe("FAILED");
    expect(String(refused.calls.at(-1)?.args?.["p_error"])).not.toContain("segredo-super-secreto");
  });
});

describe("curve recalculation after a published reading", () => {
  it("a failed recalculation is recorded and never fails the reading", async () => {
    const h = harness({ pages: { 1: page([position(1)], 1, 1, 1) } });
    const rpc = h.deps.rpc;
    h.deps.rpc = async (name, args) =>
      name === "stock_worker_refresh_curves"
        ? { data: null, error: { message: "canceling statement due to statement timeout" } }
        : rpc(name, args);
    expect(await runStockStep(h.deps, h.budget)).toEqual({
      jobId: "r1",
      status: "SUCCESS",
      done: true,
    });
    expect(h.calls.at(-1)).toMatchObject({
      name: "stock_worker_curve_failed",
      args: { p_company: "c1" },
    });
  });
});

describe("failure messages (database and logs)", () => {
  const creds = { appKey: "123456", appSecret: "segredo-super-secreto" };

  it("keeps the module's own storage messages and hides anything unexpected", () => {
    expect(safeStockMessage(new Error("Falha ao gravar as movimentações do estoque."))).toBe(
      "Falha ao gravar as movimentações do estoque.",
    );
    expect(safeStockMessage(new Error("connect ECONNREFUSED 10.0.0.5:5432"))).toBe(
      "Falha inesperada na leitura do estoque.",
    );
  });

  it("logs the technical detail of unexpected failures without credentials", () => {
    expect(
      failureDetail(new OmieError("network", "Falha de rede ao chamar o Omie.", true)),
    ).toBeNull();
    const detail = failureDetail(
      new Error("PGRST003 Timed out acquiring connection; app_secret segredo-super-secreto"),
      creds,
    );
    expect(detail).toContain("PGRST003");
    expect(detail).not.toContain("segredo-super-secreto");
  });
});
