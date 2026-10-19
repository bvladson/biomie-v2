import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTxCheckpoint } from "./checkpoint";
import { runTxSyncStep, upsertTxCanonical } from "./sync-tx.server";

const mocks = vi.hoisted(() => ({ page: vi.fn(), promote: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/jobs/worker-lease.server", () => ({
  acquireWorkerLease: async () => mocks.release,
}));
vi.mock("./sync.server", () => ({
  promoteGoldIfAllowed: (...args: unknown[]) => mocks.promote(...args),
}));
// Decryption is covered by credentials.test.ts; this suite tests checkpoints.
vi.mock("./credentials.server", () => ({
  loadOmieCredentials: async () => ({ appKey: "test", appSecret: "test" }),
}));
vi.mock("./omie-client", async (original) => {
  const module = await original<typeof import("./omie-client")>();
  return {
    ...module,
    OmieClient: class {
      listPage(...args: unknown[]) {
        return mocks.page(...args);
      }
    },
  };
});

const payload = {
  compl: { nIdNF: 1 },
  ide: { nNF: "1", dEmi: "19/10/2026", cStatus: "100" },
  total: { ICMSTot: { vNF: 100 } },
  det: [],
};

function database(
  expected: number,
  failCheckpoint = false,
  classification: Record<string, unknown> = {},
) {
  const updates: Record<string, unknown>[] = [];
  const writes: { table: string; values: unknown }[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const run = {
    id: "run-1",
    company_id: "company-1",
    entity: "invoices",
    status: "RUNNING",
    period_from: "2026-10-01",
    period_to: "2026-10-31",
    started_at: new Date().toISOString(),
    checkpoint_end: { ...emptyTxCheckpoint(), page: 2, totalPages: 2, received: 2, expected },
    pages_done: 1,
    received: 2,
    created: 2,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  const admin = {
    from: (table: string) => {
      let result: { data: unknown; error: unknown } = {
        data: table === "integration_sync_runs" ? run : null,
        error: null,
      };
      const query = {
        select: () => query,
        eq: () => query,
        upsert: (values: unknown) => {
          writes.push({ table, values });
          return query;
        },
        update: (values: Record<string, unknown>) => {
          updates.push(values);
          const error =
            failCheckpoint && !values["status"] ? { message: "simulated database failure" } : null;
          if (error) failCheckpoint = false;
          result = { data: null, error };
          return query;
        },
        single: () => Promise.resolve(result),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        error: null,
        data:
          name === "get_legacy_classification_config"
            ? classification
            : name === "get_integration_credentials"
              ? [{ app_key: "test", app_secret: "test" }]
              : name === "ingest_omie_raw"
                ? { created: 1, updated: 0, skipped: 0, ids: { "1": "raw-1" } }
                : true,
      };
    },
  };
  return { admin: admin as never, updates, calls, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.page.mockResolvedValue({ page: 2, totalPages: 2, totalRecords: null, records: [payload] });
  mocks.promote.mockResolvedValue({ ok: true, error: null });
  mocks.release.mockResolvedValue(undefined);
});

const input = {
  company: "company-1",
  entity: "invoices" as const,
  runId: "run-1",
  period: { from: "2026-10-01", to: "2026-10-31" },
  userId: null,
};

describe("transactional worker recovery", () => {
  it("does not prove a resumed monthly partition with fewer records than declared", async () => {
    const db = database(4);
    const result = await runTxSyncStep(db.admin, input);
    expect(result.status).toBe("WARNING");
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(db.updates.at(-1)?.["canonical_complete"]).toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("promotes only after the persisted prior count plus the final page match", async () => {
    const db = database(3);
    const result = await runTxSyncStep(db.admin, input);
    expect(result.status).toBe("SUCCESS");
    expect(result.received).toBe(3);
    expect(mocks.promote).toHaveBeenCalledOnce();
    expect(db.updates.at(-1)?.["raw_complete"]).toBe(true);
  });

  it("keeps the old counters and page if the checkpoint write fails", async () => {
    const db = database(3, true);
    const result = await runTxSyncStep(db.admin, input);
    expect(result.status).toBe("FAILED");
    expect(result.received).toBe(2);
    expect(db.updates.at(-1)?.["checkpoint_end"]).toMatchObject({
      page: 2,
      received: 2,
      partition: 0,
    });
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("replaces the item set even when the source document has no items", async () => {
    const db = database(0);
    await upsertTxCanonical(db.admin, "invoices", "company-1", "run-1", [
      {
        external_id: "1",
        raw_id: "raw-1",
        source_updated_at: null,
        c: { header: { number: "1" }, items: [] },
      },
    ]);
    expect(db.calls).toContainEqual({
      name: "replace_omie_canonical_items",
      args: {
        p_company: "company-1",
        p_entity: "invoices",
        p_run: "run-1",
        p_rows: [{ external_id: "1", items: [] }],
      },
    });
  });
  it("classifies a new order from private company rules before writing Canonical", async () => {
    const db = database(0, false, { default_channel: "varejo" });
    await upsertTxCanonical(db.admin, "orders", "company-1", "run-1", [
      {
        external_id: "new-order",
        raw_id: "raw-1",
        source_updated_at: null,
        raw: { cabecalho: { nome_tipo_atividade: "Orçamento - PD", etapa: "020" } },
        c: { header: { number: "1", status: "open" }, items: [] },
      },
    ]);
    expect(db.calls).toContainEqual({
      name: "get_legacy_classification_config",
      args: { p_company: "company-1" },
    });
    expect(db.writes[0]).toMatchObject({
      table: "canonical_orders",
      values: [
        {
          company_id: "company-1",
          external_id: "new-order",
          status: "open",
          business_channel: "varejo",
          operation_scope: "commercial",
          stage_code: "20",
        },
      ],
    });
    expect(JSON.stringify(db.writes[0])).not.toContain("nome_tipo_atividade");
  });
});
