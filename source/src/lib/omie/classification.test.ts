import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  classifyCanonicalHeader,
  classifyChannel,
  classifyOperation,
  loadLegacyClassificationConfig,
  type LegacyClassificationConfig,
} from "./classification.server";

const fiscalHeader = {
  status: "authorized",
  gross_amount: "1150.00",
  goods_amount: 1000,
  freight_amount: "100.00",
  insurance_amount: "20.00",
  other_expenses_amount: "40.00",
  seller_external_id: "5",
  customer_external_id: "77",
};
const retail: LegacyClassificationConfig = {
  default_channel: "varejo",
  vendors: [{ external_id: "5", name: "Vendedor comercial" }],
};

describe("approved classification overrides", () => {
  it("preserves validated external-ID classification, visibility, base and seller", () => {
    const config: LegacyClassificationConfig = {
      ...retail,
      invoice_overrides: {
        "123": {
          operation_scope: "remittance",
          business_channel: "licitacao",
          is_biomie_commercial_visible: "0",
          commercial_base_amount: "975.25",
          seller_external_id: "0008",
        },
      },
    };
    const actual = classifyCanonicalHeader(
      "invoices",
      "123",
      { ide: { natOp: "Venda" } },
      fiscalHeader,
      config,
    );
    expect(actual).toMatchObject({
      status: "authorized",
      operation_scope: "remittance",
      business_channel: "licitacao",
      is_biomie_commercial_visible: false,
      commercial_base_amount: 975.25,
      seller_external_id: "8",
    });
    expect(fiscalHeader.seller_external_id).toBe("5");
  });
  it("never applies another company's map or overwrites fiscal evidence", () => {
    const config: LegacyClassificationConfig = {
      invoice_overrides: {
        "999": { status: "authorized", operation_scope: "commercial", business_channel: "varejo" },
      },
    };
    const actual = classifyCanonicalHeader(
      "invoices",
      "123",
      {},
      { ...fiscalHeader, status: "denied" },
      config,
    );
    expect(actual).toMatchObject({
      status: "denied",
      operation_scope: "unconfirmed",
      business_channel: "unconfirmed",
      is_biomie_commercial_visible: false,
    });
  });
  it("preserves an explicit zero commercial base", () => {
    const config: LegacyClassificationConfig = {
      invoice_overrides: { "123": { commercial_base_amount: "0" } },
    };
    expect(
      classifyCanonicalHeader("invoices", "123", {}, fiscalHeader, config)[
        "commercial_base_amount"
      ],
    ).toBe(0);
  });
  it("inherits a title's channel from its approved invoice and does not add unsupported invoice fields", () => {
    const config: LegacyClassificationConfig = {
      receivable_overrides: { "7": { invoice_external_id: "42" } },
      invoice_overrides: { "42": { business_channel: "licitacao" } },
    };
    const actual = classifyCanonicalHeader(
      "receivables",
      "7",
      {},
      { document_number: "T-7" },
      config,
    );
    expect(actual).toEqual({
      document_number: "T-7",
      invoice_external_id: "42",
      business_channel: "licitacao",
    });
  });
  it("preserves order operation overrides and normalizes quote stage 10", () => {
    const config: LegacyClassificationConfig = {
      ...retail,
      orders_overrides: {
        "7": { operation_scope: "commercial", business_channel: "varejo", etapa_omie: "010" },
      },
    };
    expect(
      classifyCanonicalHeader(
        "orders",
        "7",
        { cabecalho: { etapa: "60", nome_tipo_atividade: "Remessa" } },
        {},
        config,
      ),
    ).toMatchObject({
      operation_scope: "commercial",
      stage_code: "10",
      business_channel: "varejo",
    });
  });
  it("classifies new order names and keeps missing stages unknown", () => {
    expect(
      classifyCanonicalHeader(
        "orders",
        "8",
        { cabecalho: { etapa: 20, nome_tipo_atividade: "Remessa de Produto" } },
        {},
        retail,
      ),
    ).toMatchObject({ operation_scope: "remittance", stage_code: "20" });
    expect(
      classifyCanonicalHeader(
        "orders",
        "8",
        { cabecalho: { codigo_tipo_atividade: "unknown" } },
        {},
        retail,
      ),
    ).toMatchObject({ operation_scope: "unconfirmed", stage_code: null });
  });
});

describe("deterministic legacy operation rules", () => {
  it.each(["5102", "5.102", 5102])("normalizes approved CFOP %s", (CFOP) => {
    expect(classifyOperation("invoices", { det: [{ prod: { CFOP } }] }, {})).toBe("commercial");
  });
  it("does not infer commercial scope from a normal NF, unknown CFOP or numeric activity code", () => {
    expect(classifyOperation("invoices", { ide: { finNFe: "1" } }, {})).toBe("unconfirmed");
    expect(classifyOperation("invoices", { det: [{ prod: { CFOP: "5.999" } }] }, {})).toBe(
      "unconfirmed",
    );
    expect(classifyOperation("orders", { cabecalho: { codigo_tipo_atividade: "10" } }, {})).toBe(
      "unconfirmed",
    );
  });
  it("gives explicit remittance operation 14 priority over a generic sale name", () => {
    expect(
      classifyOperation(
        "invoices",
        { pedido: { opPedido: "014" }, ide: { natOp: "Venda de produto" } },
        {},
      ),
    ).toBe("remittance");
    expect(
      classifyOperation("invoices", { ide: { finNFe: 4 }, det: [{ prod: { CFOP: 5102 } }] }, {}),
    ).toBe("remittance");
  });
  it("does not choose a commercial first item when CFOPs conflict", () => {
    expect(
      classifyOperation(
        "invoices",
        { det: [{ prod: { CFOP: "5102" } }, { prod: { CFOP: "5904" } }] },
        {},
      ),
    ).toBe("unconfirmed");
  });
  it("uses active approved name rules before built-in text matches", () => {
    const config: LegacyClassificationConfig = {
      operation_rules: [
        {
          id: 1,
          priority: 1,
          normalized_pattern: "venda especial",
          scope: "remittance",
          is_active: "1",
        },
      ],
    };
    expect(classifyOperation("invoices", { ide: { natOp: "VENDA ESPECIAL" } }, config)).toBe(
      "remittance",
    );
    expect(
      classifyOperation("orders", { cabecalho: { nome_tipo_atividade: "Orçamento - PD" } }, {}),
    ).toBe("commercial");
    expect(
      classifyOperation("invoices", { ide: { natOp: "Remessa para venda externa" } }, {}),
    ).toBe("unconfirmed");
  });
});

describe("company channel rules", () => {
  it("uses seller names with SQL LIKE and rule priorities; manual rules do not auto-match", () => {
    const config: LegacyClassificationConfig = {
      vendors: [{ external_id: "0005", name: "Equipe LICITAÇÃO" }],
      channel_rules: [
        { id: 3, priority: 100, rule_type: "default", target_channel: "varejo" },
        {
          id: 2,
          priority: 10,
          rule_type: "vendedor_nome_like",
          match_value: "%licita%",
          target_channel: "licitacao",
          ativo: "1",
        },
        { id: 1, priority: 1, rule_type: "manual", target_channel: "outros" },
      ],
    };
    expect(classifyChannel({}, fiscalHeader, config)).toBe("licitacao");
  });
  it("normalizes project IDs and does not activate disabled rules", () => {
    const config: LegacyClassificationConfig = {
      default_channel: "varejo",
      channel_rules: [
        {
          priority: 1,
          rule_type: "projeto_id_list",
          match_value: "123",
          target_channel: "outros",
          ativo: "0",
        },
        {
          priority: 2,
          rule_type: "projeto_id_list",
          match_value: " 000123, 77 ",
          target_channel: "licitacao",
        },
      ],
    };
    expect(classifyChannel({ pedido: { nIdProjeto: 123 } }, fiscalHeader, config)).toBe(
      "licitacao",
    );
  });
  it("matches customer CNPJ lists through server-only document hashes", () => {
    const document = "12345678000195";
    const config: LegacyClassificationConfig = {
      default_channel: "varejo",
      customers: [
        { external_id: "77", document_hash: createHash("sha256").update(document).digest("hex") },
      ],
      channel_rules: [
        {
          rule_type: "cliente_cnpj_list",
          match_value: "12.345.678/0001-95",
          target_channel: "outros",
        },
      ],
    };
    expect(classifyChannel({}, fiscalHeader, config)).toBe("outros");
  });
  it("keeps unseen records unconfirmed without an approved default or when seller evidence is missing", () => {
    expect(classifyChannel({}, fiscalHeader, {})).toBe("unconfirmed");
    expect(
      classifyChannel({}, fiscalHeader, {
        default_channel: "varejo",
        channel_rules: [
          { rule_type: "vendedor_nome_like", match_value: "%licita%", target_channel: "licitacao" },
        ],
      }),
    ).toBe("unconfirmed");
  });
  it("uses the exact commercial-base components and retains goods and fiscal totals", () => {
    const actual = classifyCanonicalHeader(
      "invoices",
      "123",
      { det: [{ prod: { CFOP: "5102" } }] },
      fiscalHeader,
      retail,
    );
    expect(actual).toMatchObject({
      operation_scope: "commercial",
      business_channel: "varejo",
      is_biomie_commercial_visible: true,
      commercial_base_amount: 990,
      gross_amount: "1150.00",
      goods_amount: 1000,
    });
  });
});

describe("classification RPC boundary", () => {
  it("loads config only for the requested company", async () => {
    const rpc = vi.fn(async () => ({ data: { default_channel: "varejo" }, error: null }));
    await expect(
      loadLegacyClassificationConfig({ rpc } as never, "company-1"),
    ).resolves.toMatchObject({ default_channel: "varejo" });
    expect(rpc).toHaveBeenCalledWith("get_legacy_classification_config", {
      p_company: "company-1",
    });
  });
  it("fails without printing private configuration if the RPC is unavailable or mismatched", async () => {
    const rpc = vi.fn(async () => ({
      data: { company_id: "other-company", customers: [{ document_original: "private-document" }] },
      error: null,
    }));
    await expect(loadLegacyClassificationConfig({ rpc } as never, "company-1")).rejects.toThrow(
      "outra empresa",
    );
  });
});
