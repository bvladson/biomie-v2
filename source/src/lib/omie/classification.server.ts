import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { OmieTxEntity } from "./adapters";

type Row = Record<string, unknown>;
export type OperationScope = "commercial" | "remittance" | "unknown" | "unconfirmed";
export type BusinessChannel = "varejo" | "licitacao" | "outros" | "unconfirmed";
export interface LegacyClassificationConfig {
  invoice_overrides?: Record<string, Row>;
  orders_overrides?: Record<string, Row>;
  receivable_overrides?: Record<string, Row>;
  operation_rules?: Row[];
  channel_rules?: Row[];
  vendors?: Row[];
  customers?: Row[];
  company_slug?: string;
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

export function classifyOperation(
  entity: "invoices" | "orders",
  raw: Row,
  config: LegacyClassificationConfig,
): OperationScope {
  if (entity === "orders") {
    // Legacy's activity-code map is empty. An arbitrary numeric activity code is not evidence.
    return scopeByName(object(raw["cabecalho"])["nome_tipo_atividade"], config);
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
  const details = Array.isArray(raw["det"]) ? raw["det"] : [];
  const codes = details
    .map((detail) => digits(object(object(detail)["prod"])["CFOP"]))
    .filter(Boolean);
  if (!codes.length) return "unconfirmed"; // finNFe=1 does not prove a sale.
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

function overrideFor(overrides: Record<string, Row> | undefined, externalId: unknown): Row {
  const rawId = text(externalId);
  return object(overrides?.[rawId] ?? overrides?.[id(externalId)]);
}

function like(haystack: string, pattern: unknown): boolean {
  const expression = lower(pattern);
  if (!expression) return false;
  const escaped = expression
    .split(/([%_])/)
    .map((piece) =>
      piece === "%" ? ".*" : piece === "_" ? "." : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${escaped}$`, "su").test(lower(haystack));
}

function rowById(rows: Row[] | undefined, externalId: unknown): Row {
  const external = id(externalId);
  return external ? object(rows?.find((row) => id(row["external_id"]) === external)) : {};
}

export function classifyChannel(
  raw: Row,
  header: Row,
  config: LegacyClassificationConfig,
): BusinessChannel {
  const vendor = rowById(config.vendors, header["seller_external_id"]);
  const sellerName = text(vendor["name"]) || text(object(raw["pedido"])["cNomeVendedor"]);
  const customer = rowById(config.customers, header["customer_external_id"]);
  const documentDigits = digits(
    [
      object(raw["nfDestInt"])["cnpj_cpf"],
      raw["cnpj_cpf"],
      customer["document_original"],
      customer["documento"],
    ]
      .map(text)
      .find(Boolean),
  );
  const document = [11, 14].includes(documentDigits.length) ? documentDigits : "";
  const hash = lower(customer["document_hash"]);
  const documentHash = /^[a-f0-9]{64}$/.test(hash) ? hash : "";
  const notes = [
    object(raw["infAdic"])["infCpl"],
    object(raw["infAdic"])["infAdFisco"],
    object(raw["compl"])["cObs"],
    object(raw["observacoes"])["obs_venda"],
    object(raw["observacoes"])["obs_interna"],
    object(raw["cabecalho"])["observacao"],
    object(raw["frete"])["observacao"],
  ]
    .map(text)
    .filter(Boolean)
    .join(" ");
  const project = id(
    object(raw["pedido"])["nIdProjeto"] ??
      object(raw["compl"])["nIdProjeto"] ??
      object(raw["informacoes_adicionais"])["codProj"] ??
      raw["nIdProjeto"],
  );
  for (const rule of ordered(config.channel_rules)) {
    const target = channel(rule["target_channel"]);
    if (target === "unconfirmed") continue;
    const type = text(rule["rule_type"]);
    if (type === "manual") continue;
    if (type === "vendedor_nome_like" && !sellerName && text(header["seller_external_id"]))
      return "unconfirmed";
    if (
      type === "cliente_cnpj_list" &&
      !document &&
      !documentHash &&
      text(header["customer_external_id"])
    )
      return "unconfirmed";
    const values = text(rule["match_value"])
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const matches =
      type === "vendedor_nome_like"
        ? Boolean(sellerName) && like(sellerName, rule["match_value"])
        : type === "pedido_obs_like"
          ? Boolean(notes) && like(notes, rule["match_value"])
          : type === "cliente_cnpj_list"
            ? values.some((value) =>
                document
                  ? digits(value) === document
                  : documentHash &&
                    createHash("sha256").update(digits(value)).digest("hex") === documentHash,
              )
            : type === "projeto_id_list"
              ? Boolean(project) && project !== "0" && values.some((value) => id(value) === project)
              : type === "default";
    if (matches) return target;
  }
  // Unlike legacy's implicit varejo fallback, only an explicitly imported
  // approved company default can classify a previously unseen record.
  return channel(config.default_channel);
}

function amount(value: unknown): number | undefined {
  if (value === null || value === undefined || text(value) === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  const overrides =
    entity === "invoices"
      ? config.invoice_overrides
      : entity === "orders"
        ? config.orders_overrides
        : config.receivable_overrides;
  const approved = overrideFor(overrides, externalId);
  const mappedHeader = { ...header };
  for (const field of [
    "seller_external_id",
    ...(entity === "receivables" ? ["invoice_external_id"] : []),
  ]) {
    if (Object.hasOwn(approved, field))
      mappedHeader[field] = text(approved[field]) ? id(approved[field]) : null;
  }
  const linked =
    entity === "receivables"
      ? overrideFor(config.invoice_overrides, mappedHeader["invoice_external_id"])
      : {};
  const approvedChannel = approved["business_channel"] ?? linked["business_channel"];
  mappedHeader["business_channel"] =
    approvedChannel !== undefined
      ? channel(approvedChannel)
      : classifyChannel(raw, mappedHeader, config);
  if (entity === "orders") {
    mappedHeader["operation_scope"] = Object.hasOwn(approved, "operation_scope")
      ? scope(approved["operation_scope"])
      : classifyOperation("orders", raw, config);
    const stage = text(
      approved["stage_code"] ?? approved["etapa_omie"] ?? object(raw["cabecalho"])["etapa"],
    );
    mappedHeader["stage_code"] = /^\d+$/.test(stage) ? id(stage) : null;
  }
  if (entity === "invoices") {
    mappedHeader["operation_scope"] = Object.hasOwn(approved, "operation_scope")
      ? scope(approved["operation_scope"])
      : classifyOperation("invoices", raw, config);
    mappedHeader["is_biomie_commercial_visible"] =
      flag(approved["is_biomie_commercial_visible"]) ??
      mappedHeader["business_channel"] === "varejo";
    const gross = amount(header["gross_amount"]);
    const freight = amount(header["freight_amount"]);
    const insurance = amount(header["insurance_amount"]);
    const other = amount(header["other_expenses_amount"]);
    const computedBase =
      gross !== undefined && freight !== undefined && insurance !== undefined && other !== undefined
        ? Math.max(
            0,
            (Math.round(gross * 100) -
              Math.round(freight * 100) -
              Math.round(insurance * 100) -
              Math.round(other * 100)) /
              100,
          )
        : null;
    mappedHeader["commercial_base_amount"] =
      amount(approved["commercial_base_amount"]) ?? computedBase;
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
