import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  classifyCanonicalHeader,
  classifyOperation,
  commercialBase,
  decideChannel,
  loadLegacyClassificationConfig,
  normalizeSellerName,
  type LegacyClassificationConfig,
} from "./classification.server";

const GROUP_CNPJ = "11222333000181"; // fictitious group company
const PUBLIC_BODY_CNPJ = "44555666000199"; // fictitious public customer

/** Mirrors the real legacy rule set: substring/observation rules + intra-group + default. */
function legacyRules(defaultTarget: string) {
  return [
    {
      id: 49,
      rule_type: "cliente_cnpj_list",
      target_channel: "outros",
      priority: 1,
      ativo: 1,
      match_value: `${GROUP_CNPJ},00.111.222/0001-33`,
    },
    {
      id: 35,
      rule_type: "vendedor_nome_like",
      target_channel: "licitacao",
      priority: 10,
      ativo: 1,
      match_value: "%LICITAC%",
    },
    {
      id: 37,
      rule_type: "vendedor_nome_like",
      target_channel: "licitacao",
      priority: 12,
      ativo: 1,
      match_value: "%LICITA%",
    },
    {
      id: 38,
      rule_type: "pedido_obs_like",
      target_channel: "licitacao",
      priority: 20,
      ativo: 1,
      match_value: "%pregao%",
    },
    {
      id: 40,
      rule_type: "pedido_obs_like",
      target_channel: "licitacao",
      priority: 22,
      ativo: 1,
      match_value: "%edital%",
    },
    {
      id: 41,
      rule_type: "pedido_obs_like",
      target_channel: "licitacao",
      priority: 23,
      ativo: 1,
      match_value: "%empenho%",
    },
    {
      id: 50,
      rule_type: "projeto_id_list",
      target_channel: "licitacao",
      priority: 30,
      ativo: 1,
      match_value: "123",
    },
    {
      id: 44,
      rule_type: "default",
      target_channel: defaultTarget,
      priority: 999,
      ativo: 1,
      match_value: "",
    },
  ];
}

const COMPANIES: Record<string, { defaultChannel: string; licitacaoCode: string | null }> = {
  expert: { defaultChannel: "licitacao", licitacaoCode: "8766069241" },
  "uni-design": { defaultChannel: "licitacao", licitacaoCode: "10118842872" },
  "mag-matriz": { defaultChannel: "licitacao", licitacaoCode: null },
  ergooffice: { defaultChannel: "licitacao", licitacaoCode: "7467611512" },
  "mag-filial": { defaultChannel: "varejo", licitacaoCode: "8766069381" },
};

function companyConfig(slug: string): LegacyClassificationConfig {
  const company = COMPANIES[slug]!;
  return {
    company_slug: slug,
    default_channel: company.defaultChannel,
    licitacao_seller_codes: company.licitacaoCode ? [company.licitacaoCode] : [],
    channel_rules: legacyRules(company.defaultChannel),
    vendors: [
      { external_id: "100", name: "ROBERTO SIQ." },
      { external_id: "200", name: "Equipe LICITAÇÃO" },
      { external_id: "300", name: "Ex-licitação João" },
      ...(company.licitacaoCode ? [{ external_id: company.licitacaoCode, name: "Licitação" }] : []),
      { external_id: "999", name: "LICITAÇÃO" },
    ],
    customers: [
      { external_id: "1", document_original: PUBLIC_BODY_CNPJ },
      { external_id: "2", document_original: GROUP_CNPJ },
      {
        external_id: "3",
        document_hash: createHash("sha256").update(GROUP_CNPJ).digest("hex"),
      },
    ],
  };
}

const baseHeader = {
  status: "authorized",
  gross_amount: "1150.00",
  goods_amount: 1000,
  freight_amount: "100.00",
  insurance_amount: "20.00",
  other_expenses_amount: "40.00",
  customer_external_id: "1",
};

const invoiceRaw = (extra: Record<string, unknown> = {}) => ({
  det: [{ prod: { CFOP: "5.102" } }],
  ...extra,
});

describe.each(Object.keys(COMPANIES))("official channel rule — %s", (slug) => {
  const config = companyConfig(slug);
  const classify = (seller: string, raw: Record<string, unknown> = invoiceRaw(), customer = "1") =>
    classifyCanonicalHeader(
      "invoices",
      "nf-1",
      raw,
      { ...baseHeader, seller_external_id: seller, customer_external_id: customer },
      config,
    );

  it("common seller selling to a public body is VAREJO", () => {
    expect(classify("100")).toMatchObject({
      business_channel: "varejo",
      channel_reason: "default_varejo",
      is_biomie_commercial_visible: true,
    });
  });

  it("the seller named Licitação is LICITAÇÃO, by code when configured and by exact name", () => {
    const code = COMPANIES[slug]!.licitacaoCode;
    if (code)
      expect(classify(code)).toMatchObject({
        business_channel: "licitacao",
        channel_reason: "licitacao_seller_code",
        is_biomie_commercial_visible: false,
      });
    expect(classify("999")).toMatchObject({
      business_channel: "licitacao",
      channel_reason: "licitacao_seller_name",
    });
  });

  it("a name that only contains 'licita' is not the Licitação seller", () => {
    expect(classify("200")["business_channel"]).toBe("varejo");
    expect(classify("300")["business_channel"]).toBe("varejo");
  });

  it("observation words (pregão, edital, empenho) never classify", () => {
    const raw = invoiceRaw({
      infAdic: { infCpl: "Pregão eletrônico 12/2026 - edital 45 - empenho 2026NE0001" },
    });
    expect(classify("100", raw)["business_channel"]).toBe("varejo");
  });

  it("project lists never classify", () => {
    const raw = invoiceRaw({ pedido: { nIdProjeto: 123 }, compl: { nIdProjeto: 123 } });
    expect(classify("100", raw)["business_channel"]).toBe("varejo");
  });

  it("intra-group customers are OUTROS (outside the numbers), by document or document hash", () => {
    expect(classify("100", invoiceRaw(), "2")).toMatchObject({
      business_channel: "outros",
      channel_reason: "intra_group",
      is_biomie_commercial_visible: false,
    });
    expect(classify("100", invoiceRaw(), "3")["business_channel"]).toBe("outros");
    const raw = invoiceRaw({ nfDestInt: { cnpj_cpf: "11.222.333/0001-81" } });
    expect(classify("100", raw, "unknown-customer")["business_channel"]).toBe("outros");
  });

  it("missing seller and customer falls back to VAREJO; the company default channel never classifies", () => {
    const actual = classifyCanonicalHeader(
      "invoices",
      "nf-2",
      invoiceRaw(),
      { ...baseHeader, customer_external_id: null },
      config,
    );
    expect(actual).toMatchObject({ business_channel: "varejo", channel_reason: "default_varejo" });
  });
});

describe("authority of the official rule over legacy snapshots", () => {
  it("ignores legacy channel, visibility, scope and base; keeps only a missing seller", () => {
    const config: LegacyClassificationConfig = {
      ...companyConfig("expert"),
      invoice_overrides: {
        "123": {
          operation_scope: "remittance",
          business_channel: "licitacao",
          is_biomie_commercial_visible: "0",
          commercial_base_amount: "975.25",
          seller_external_id: "0100",
        },
      },
    };
    const actual = classifyCanonicalHeader(
      "invoices",
      "123",
      invoiceRaw(),
      { ...baseHeader, seller_external_id: null },
      config,
    );
    expect(actual).toMatchObject({
      status: "authorized",
      seller_external_id: "100",
      operation_scope: "commercial",
      business_channel: "varejo",
      is_biomie_commercial_visible: true,
      commercial_base_amount: 990,
    });
  });

  it("the payload seller wins over the legacy seller", () => {
    const config: LegacyClassificationConfig = {
      ...companyConfig("mag-filial"),
      invoice_overrides: { "9": { seller_external_id: "100" } },
    };
    expect(
      classifyCanonicalHeader(
        "invoices",
        "9",
        invoiceRaw(),
        { ...baseHeader, seller_external_id: "8766069381" },
        config,
      ),
    ).toMatchObject({ seller_external_id: "8766069381", business_channel: "licitacao" });
  });

  it("an explicit manual override wins and is traceable", () => {
    const config: LegacyClassificationConfig = {
      ...companyConfig("uni-design"),
      manual_channel_overrides: { "55": "licitacao" },
    };
    expect(
      classifyCanonicalHeader(
        "invoices",
        "55",
        invoiceRaw(),
        { ...baseHeader, seller_external_id: "100" },
        config,
      ),
    ).toMatchObject({ business_channel: "licitacao", channel_reason: "manual_override" });
  });

  it("never rewrites fiscal status", () => {
    const actual = classifyCanonicalHeader(
      "invoices",
      "1",
      {},
      { ...baseHeader, status: "denied", seller_external_id: "100" },
      companyConfig("expert"),
    );
    expect(actual).toMatchObject({ status: "denied", operation_scope: "unconfirmed" });
  });

  it("titles and orders follow the same seller rule", () => {
    const config = companyConfig("ergooffice");
    expect(
      classifyCanonicalHeader(
        "receivables",
        "t1",
        {},
        { seller_external_id: "7467611512", customer_external_id: "1" },
        config,
      ),
    ).toMatchObject({ business_channel: "licitacao", channel_reason: "licitacao_seller_code" });
    expect(
      classifyCanonicalHeader(
        "orders",
        "o1",
        { cabecalho: { etapa: "50" }, det: [{ produto: { cfop: "6.102" } }] },
        { seller_external_id: "100", customer_external_id: "2" },
        config,
      ),
    ).toMatchObject({
      business_channel: "outros",
      operation_scope: "commercial",
      stage_code: "50",
    });
  });
});

describe("fiscal patterns found in the real 2026 data", () => {
  const nf = (...cfops: string[]) => ({ det: cfops.map((CFOP) => ({ prod: { CFOP } })) });
  it("counts a future-delivery sale once: billing is the sale, delivery is a remittance", () => {
    expect(classifyOperation("invoices", nf("5.922"), {})).toBe("commercial");
    expect(classifyOperation("invoices", nf("6.922"), {})).toBe("commercial");
    for (const cfop of ["5.116", "5.117", "6.116", "6.117"])
      expect(classifyOperation("invoices", nf(cfop), {})).toBe("remittance");
    expect(classifyOperation("invoices", nf("5.116", "5.916"), {})).toBe("remittance");
  });
  it("treats shipments on behalf of third parties and transfers as remittances", () => {
    for (const cfop of ["5.923", "6.923", "5.409", "5.152", "6.152"])
      expect(classifyOperation("invoices", nf(cfop), {})).toBe("remittance");
  });
  it("keeps a sale with bonus items as a sale, and unknown operations pending", () => {
    expect(classifyOperation("invoices", nf("5.101", "5.910"), {})).toBe("commercial");
    expect(classifyOperation("invoices", nf("5.949"), {})).toBe("unconfirmed");
    expect(classifyOperation("invoices", nf("5.102", "5.904"), {})).toBe("unconfirmed");
  });
});

describe("order operation scope from real Omie payload fields", () => {
  it("uses item CFOPs when nome_tipo_atividade is absent", () => {
    const order = (cfops: string[]) => ({
      cabecalho: { etapa: "20" },
      det: cfops.map((cfop) => ({ produto: { cfop } })),
    });
    expect(classifyOperation("orders", order(["5.102", "5.102"]), {})).toBe("commercial");
    expect(classifyOperation("orders", order(["5.910"]), {})).toBe("remittance");
    expect(classifyOperation("orders", order(["5.102", "5.910"]), {})).toBe("commercial");
    expect(classifyOperation("orders", order(["5.102", "5.904"]), {})).toBe("unconfirmed");
    expect(classifyOperation("orders", order(["5.949"]), {})).toBe("unconfirmed");
    expect(classifyOperation("orders", { cabecalho: {} }, {})).toBe("unconfirmed");
  });
  it("prefers an explicit activity name when Omie sends it", () => {
    expect(
      classifyOperation(
        "orders",
        {
          cabecalho: { nome_tipo_atividade: "Remessa de Produto" },
          det: [{ produto: { cfop: "5.102" } }],
        },
        {},
      ),
    ).toBe("remittance");
  });
  it("keeps the stage pending when Omie does not send it", () => {
    expect(
      classifyCanonicalHeader("orders", "8", { cabecalho: {} }, {}, companyConfig("expert")),
    ).toMatchObject({ operation_scope: "unconfirmed", stage_code: null });
  });
});

describe("invoice operation rules", () => {
  it.each(["5102", "5.102", 5102])("normalizes approved CFOP %s", (CFOP) => {
    expect(classifyOperation("invoices", { det: [{ prod: { CFOP } }] }, {})).toBe("commercial");
  });
  it("does not infer commercial scope from a normal NF or an unknown CFOP", () => {
    expect(classifyOperation("invoices", { ide: { finNFe: "1" } }, {})).toBe("unconfirmed");
    expect(classifyOperation("invoices", { det: [{ prod: { CFOP: "5.999" } }] }, {})).toBe(
      "unconfirmed",
    );
  });
  it("gives explicit remittance operation 14 and finNFe 4 priority", () => {
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
  it("uses active approved operation-name rules before built-in text matches", () => {
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
      classifyOperation("invoices", { ide: { natOp: "Remessa para venda externa" } }, {}),
    ).toBe("unconfirmed");
  });
});

describe("commercial revenue contract", () => {
  it("is gross - freight - insurance - other expenses, IPI stays in the base", () => {
    // 1000 goods + 50 IPI + 100 freight = 1150 gross; minus freight/insurance/other.
    expect(commercialBase(baseHeader)).toBe(990);
    expect(
      commercialBase({
        gross_amount: 1050,
        freight_amount: 0,
        insurance_amount: 0,
        other_expenses_amount: 0,
      }),
    ).toBe(1050);
  });
  it("treats absent components as zero and keeps cents exact", () => {
    expect(commercialBase({ gross_amount: "0.30", freight_amount: "0.10" })).toBe(0.2);
    expect(commercialBase({})).toBeNull();
  });
});

describe("seller name normalization", () => {
  it("only an exact LICITACAO name matches", () => {
    expect(normalizeSellerName(" Licitação ")).toBe("LICITACAO");
    expect(normalizeSellerName("LICITAÇÃO")).toBe("LICITACAO");
    expect(normalizeSellerName("Equipe Licitação")).toBe("EQUIPE LICITACAO");
    expect(
      decideChannel({ externalId: "x", sellerCode: null, sellerName: "licitação" }, {}),
    ).toEqual({ channel: "licitacao", reason: "licitacao_seller_name" });
  });
});

describe("classification RPC boundary", () => {
  it("loads config only for the requested company", async () => {
    const rpc = vi.fn(async () => ({ data: { default_view_channel: "varejo" }, error: null }));
    await expect(
      loadLegacyClassificationConfig({ rpc } as never, "company-1"),
    ).resolves.toMatchObject({ default_view_channel: "varejo" });
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
