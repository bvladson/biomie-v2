import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { OmieTxEntity } from "./adapters";

type Row = Record<string, unknown>;
export type OperationScope = "commercial" | "remittance" | "unknown" | "unconfirmed";
export type BusinessChannel = "varejo" | "licitacao" | "outros" | "unconfirmed";

/**
 * Why a record received its sales channel. Persisted next to the channel so
 * every divergence can be explained by a documented rule.
 */
export type ChannelReason =
  | "manual_override"
  | "intra_group"
  | "licitacao_seller_code"
  | "licitacao_seller_name"
  | "default_varejo";

/**
 * Private, server-only configuration per company. Legacy keys are kept for
 * reference; only the fields documented below influence classification.
 *
 * - `licitacao_seller_codes`: Omie codes of the operational seller "Licitação".
 * - `channel_rules`: only active `cliente_cnpj_list` rules targeting `outros`
 *   (intra-group customers, outside the numbers) are honored.
 * - `manual_channel_overrides`: explicit manual decisions per external id.
 * - `default_view_channel` / `default_channel`: UI preference only. They NEVER
 *   classify a sale (default_view_channel != sales channel classification).
 * - `*_overrides`: legacy snapshot used only as a seller fallback and for
 *   reconciliation; legacy channels/scopes are not authoritative.
 */
export interface LegacyClassificationConfig {
  invoice_overrides?: Record<string, Row>;
  orders_overrides?: Record<string, Row>;
  receivable_overrides?: Record<string, Row>;
  manual_channel_overrides?: Record<string, string>;
  licitacao_seller_codes?: string[];
  operation_rules?: Row[];
  channel_rules?: Row[];
  vendors?: Row[];
  customers?: Row[];
  company_slug?: string;
  default_view_channel?: string;
  default_channel?: string;
}

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value).trim();
const lower = (value: unknown) => text(value).toLocaleLowerCase("pt-BR");
const digits = (value: unknown) => text(value).replace(/\D/g, "");
const id = (value: unknown) => {
  const valueText = text(value);
  return /^\d+$/.test(valueText) ? valueText.replace(/^0+(?=\d)/, "") : valueText;
};
const flag = (value: unknown): boolean | undefined => {
  if ([true, 1, "1", "S", "s", "true"].includes(value as never)) return true;
  if ([false, 0, "0", "N", "n", "false"].includes(value as never)) return false;
  return undefined;
};
const active = (row: Row) => flag(row["is_active"] ?? row["ativo"]) !== false;
const channel = (value: unknown): BusinessChannel =>
  ["varejo", "licitacao", "outros"].includes(lower(value))
    ? (lower(value) as BusinessChannel)
    : "unconfirmed";
const scope = (value: unknown): OperationScope =>
  ["commercial", "remittance", "unknown"].includes(lower(value))
    ? (lower(value) as OperationScope)
    : "unconfirmed";
const priority = (row: Row) =>
  Number.isFinite(Number(row["priority"])) ? Number(row["priority"]) : 1000;
const ordered = (rows: Row[] | undefined) =>
  [...(rows ?? [])]
    .filter(active)
    .sort(
      (a, b) =>
        priority(a) - priority(b) ||
        text(a["id"]).localeCompare(text(b["id"]), "en", { numeric: true }),
    );

const COMMERCIAL_NAMES = [
  "orçamento - pd",
  "orcamento - pd",
  "orcamento pd",
  "orçamento pd",
  "orcamento-pd",
  "orçamento-pd",
  "venda de mercadorias",
  "venda de produto",
  "venda produto",
  "pedido de venda",
  "venda",
];
const REMITTANCE_NAMES = [
  "remessa de produto",
  "remessa de produtos",
  "remessa produto",
  "simples remessa",
  "remessa",
  "transferência",
  "transferencia",
  "devolução",
  "devolucao",
  "bonificação",
  "bonificacao",
  "demonstração",
  "demonstracao",
];
// Exact allowlists from legacy OmieOperationScope; no broad 5.xxx/6.xxx assumption.
const REMITTANCE_CFOPS = new Set([
  "5904",
  "5905",
  "5907",
  "5908",
  "5910",
  "5911",
  "5912",
  "5914",
  "5915",
  "5916",
  "5917",
  "5920",
  "5921",
  "6904",
  "6905",
  "6907",
  "6908",
  "6910",
  "6911",
  "6912",
  "6914",
  "6915",
  "6916",
  "6917",
  "6920",
  "6921",
]);
const COMMERCIAL_CFOPS = new Set([
  "5101",
  "5102",
  "5103",
  "5104",
  "5105",
  "5106",
  "5107",
  "5108",
  "5109",
  "5110",
  "5111",
  "5112",
  "5113",
  "5114",
  "5115",
  "5116",
  "5117",
  "5118",
  "5119",
  "5403",
  "5922",
  "6101",
  "6102",
  "6103",
  "6104",
  "6105",
  "6106",
  "6107",
  "6108",
  "6109",
  "6110",
  "6111",
  "6112",
  "6113",
  "6114",
  "6115",
  "6116",
  "6117",
  "6118",
  "6119",
]);

function scopeByName(name: unknown, config: LegacyClassificationConfig): OperationScope {
  const normalized = lower(name);
  if (!normalized) return "unconfirmed";
  const rules = ordered(config.operation_rules).filter(
    (rule) =>
      text(rule["normalized_pattern"]) &&
      ["commercial", "remittance"].includes(text(rule["scope"])),
  );
  const exact = rules.find((rule) => normalized === lower(rule["normalized_pattern"]));
  if (exact) return scope(exact["scope"]);
  const contained = rules.find((rule) => normalized.includes(lower(rule["normalized_pattern"])));
  if (contained) return scope(contained["scope"]);
  if (COMMERCIAL_NAMES.includes(normalized)) return "commercial";
  if (REMITTANCE_NAMES.includes(normalized)) return "remittance";
  const sale = COMMERCIAL_NAMES.some((name) => normalized.includes(name));
  const remittance = REMITTANCE_NAMES.some((name) => normalized.includes(name));
  // A conflicting free-text description must not silently become commercial.
  if (sale && remittance) return "unconfirmed";
  return sale ? "commercial" : remittance ? "remittance" : "unconfirmed";
}

/** Every item must agree; one unknown or conflicting CFOP keeps the document pending. */
function scopeByCfops(codes: string[]): OperationScope {
  if (!codes.length) return "unconfirmed";
  const classifications = new Set(
    codes.map((code) =>
      REMITTANCE_CFOPS.has(code)
        ? "remittance"
        : COMMERCIAL_CFOPS.has(code)
          ? "commercial"
          : "unconfirmed",
    ),
  );
  return classifications.size === 1 ? [...classifications][0]! : "unconfirmed";
}

export function classifyOperation(
  entity: "invoices" | "orders",
  raw: Row,
  config: LegacyClassificationConfig,
): OperationScope {
  const details = Array.isArray(raw["det"]) ? raw["det"] : [];
  if (entity === "orders") {
    // ListarPedidos does not return nome_tipo_atividade in this account; when it
    // does, the name wins. Otherwise the item CFOPs (same fiscal rule used for
    // invoices) decide. Without either signal the order stays pending.
    const byName = scopeByName(object(raw["cabecalho"])["nome_tipo_atividade"], config);
    if (byName !== "unconfirmed") return byName;
    return scopeByCfops(
      details.map((detail) => digits(object(object(detail)["produto"])["cfop"])).filter(Boolean),
    );
  }
  const operation = object(raw["pedido"])["opPedido"];
  if (id(operation) === "14") return "remittance";
  if (text(operation) && !/^\d+$/.test(text(operation))) {
    const classified = scopeByName(operation, config);
    if (classified !== "unconfirmed") return classified;
  }
  const ide = object(raw["ide"]);
  if (text(ide["natOp"])) return scopeByName(ide["natOp"], config);
  if (id(ide["finNFe"]) === "4") return "remittance";
  return scopeByCfops(
    details.map((detail) => digits(object(object(detail)["prod"])["CFOP"])).filter(Boolean),
  );
}

/** Uppercase, accent-free, single-spaced name used only for exact comparisons. */
export function normalizeSellerName(value: unknown): string {
  return text(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export const LICITACAO_SELLER_NAME = "LICITACAO";

function rowById(rows: Row[] | undefined, externalId: unknown): Row {
  const external = id(externalId);
  return external ? object(rows?.find((row) => id(row["external_id"]) === external)) : {};
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Documents of group companies, from active intra-group (`outros`) customer rules only. */
export function intraGroupDocuments(config: LegacyClassificationConfig): {
  plain: Set<string>;
  hashed: Set<string>;
} {
  const plain = new Set<string>();
  for (const rule of ordered(config.channel_rules)) {
    if (text(rule["rule_type"]) !== "cliente_cnpj_list") continue;
    if (channel(rule["target_channel"]) !== "outros") continue;
    for (const value of text(rule["match_value"]).split(",")) {
      const document = digits(value);
      if (document.length === 11 || document.length === 14) plain.add(document);
    }
  }
  return { plain, hashed: new Set([...plain].map(sha256)) };
}

export interface ChannelInput {
  externalId: string;
  sellerCode: unknown;
  sellerName?: unknown;
  customerExternalId?: unknown;
  customerDocument?: unknown;
}

export interface ChannelDecision {
  channel: BusinessChannel;
  reason: ChannelReason;
}

/**
 * Official rule (approved 29/09/2026), in order:
 * manual override > intra-group customer (outros, outside the numbers) >
 * Omie code of the seller "Licitação" > normalized seller name LICITACAO >
 * VAREJO. Observation, project, customer type and the company default channel
 * never classify a sale.
 */
export function decideChannel(
  input: ChannelInput,
  config: LegacyClassificationConfig,
): ChannelDecision {
  const manual = config.manual_channel_overrides?.[input.externalId];
  if (manual !== undefined && channel(manual) !== "unconfirmed")
    return { channel: channel(manual), reason: "manual_override" };

  const customer = rowById(config.customers, input.customerExternalId);
  const documentDigits = digits(
    [input.customerDocument, customer["document_original"], customer["documento"]]
      .map(text)
      .find(Boolean),
  );
  const group = intraGroupDocuments(config);
  const documentHash = lower(customer["document_hash"]);
  if (
    (documentDigits && group.plain.has(documentDigits)) ||
    (/^[a-f0-9]{64}$/.test(documentHash) && group.hashed.has(documentHash))
  )
    return { channel: "outros", reason: "intra_group" };

  const sellerCode = id(input.sellerCode);
  const licitacaoCodes = new Set((config.licitacao_seller_codes ?? []).map(id).filter(Boolean));
  if (sellerCode && licitacaoCodes.has(sellerCode))
    return { channel: "licitacao", reason: "licitacao_seller_code" };

  const sellerName =
    text(input.sellerName) || text(rowById(config.vendors, input.sellerCode)["name"]);
  if (normalizeSellerName(sellerName) === LICITACAO_SELLER_NAME)
    return { channel: "licitacao", reason: "licitacao_seller_name" };

  return { channel: "varejo", reason: "default_varejo" };
}

function overrideFor(overrides: Record<string, Row> | undefined, externalId: unknown): Row {
  const rawId = text(externalId);
  return object(overrides?.[rawId] ?? overrides?.[id(externalId)]);
}

function amount(value: unknown): number | undefined {
  if (value === null || value === undefined || text(value) === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** gross - freight - insurance - other expenses; IPI stays in the base. */
export function commercialBase(header: Row): number | null {
  const gross = amount(header["gross_amount"]);
  const freight = amount(header["freight_amount"]) ?? 0;
  const insurance = amount(header["insurance_amount"]) ?? 0;
  const other = amount(header["other_expenses_amount"]) ?? 0;
  if (gross === undefined) return null;
  return (
    (Math.round(gross * 100) -
      Math.round(freight * 100) -
      Math.round(insurance * 100) -
      Math.round(other * 100)) /
    100
  );
}

/** Returns only fields that exist on the target canonical table. Never changes fiscal status. */
export function classifyCanonicalHeader(
  entity: OmieTxEntity,
  externalId: string,
  raw: Row,
  header: Row,
  config: LegacyClassificationConfig,
): Row {
  if (entity === "settlements") return header;
  const legacy = overrideFor(
    entity === "invoices"
      ? config.invoice_overrides
      : entity === "orders"
        ? config.orders_overrides
        : config.receivable_overrides,
    externalId,
  );
  const mappedHeader = { ...header };
  // The Omie payload is authoritative. The legacy snapshot only fills a seller
  // the payload could not determine (e.g. invoices without installment titles).
  if (!text(mappedHeader["seller_external_id"]) && text(legacy["seller_external_id"]))
    mappedHeader["seller_external_id"] = id(legacy["seller_external_id"]);

  const decision = decideChannel(
    {
      externalId,
      sellerCode: mappedHeader["seller_external_id"],
      customerExternalId: mappedHeader["customer_external_id"],
      customerDocument:
        entity === "invoices"
          ? object(raw["nfDestInt"])["cnpj_cpf"]
          : entity === "receivables"
            ? raw["cnpj_cpf"]
            : undefined,
    },
    config,
  );
  mappedHeader["business_channel"] = decision.channel;
  mappedHeader["channel_reason"] = decision.reason;

  if (entity === "orders") {
    mappedHeader["operation_scope"] = classifyOperation("orders", raw, config);
    const stage = text(object(raw["cabecalho"])["etapa"] ?? legacy["stage_code"]);
    mappedHeader["stage_code"] = /^\d+$/.test(stage) ? id(stage) : null;
  }
  if (entity === "invoices") {
    mappedHeader["operation_scope"] = classifyOperation("invoices", raw, config);
    // Legacy meaning kept: "visible in the retail commercial universe". Licitação
    // is counted through its own channel in fact_sales; intra-group (outros) is not.
    mappedHeader["is_biomie_commercial_visible"] = decision.channel === "varejo";
    mappedHeader["commercial_base_amount"] = commercialBase(header);
  }
  return mappedHeader;
}

/** Credentials/documents inside this config remain server-only; never log the result. */
export async function loadLegacyClassificationConfig(
  admin: SupabaseClient<Database>,
  company: string,
): Promise<LegacyClassificationConfig> {
  const db = admin as unknown as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await db.rpc("get_legacy_classification_config", { p_company: company });
  if (error || !data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Não foi possível carregar as regras privadas de classificação Omie.");
  const config = object(data);
  if (config["company_id"] !== undefined && text(config["company_id"]) !== company)
    throw new Error("Configuração de classificação pertence a outra empresa.");
  return config as LegacyClassificationConfig;
}
