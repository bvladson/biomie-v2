/**
 * Omie adapters — the ONLY place that knows Omie payload shapes.
 * Each adapter declares the documented endpoint/call, how to find the list in
 * the response, and how to map one record to RAW metadata and to the BIOMIE
 * canonical model. Screens never see these shapes.
 *
 * Endpoints/calls confirmed in the official API reference
 * (api.omie.com.br/docs): geral/vendedores:ListarVendedores,
 * geral/clientes:ListarClientes, geral/produtos:ListarProdutos.
 * Response field names are validated against the first real response; any
 * field missing there is reported as a warning, never invented.
 */

export type OmieEntity = "vendors" | "customers" | "products";
export const ENTITY_ORDER: OmieEntity[] = ["vendors", "customers", "products"];
export const ENTITY_LABEL: Record<OmieEntity, string> = {
  vendors: "Vendedores",
  customers: "Clientes",
  products: "Produtos",
};

type Payload = Record<string, unknown>;

export interface RawRecord {
  external_id: string;
  payload: Payload;
  source_updated_at: string | null;
  is_active: boolean | null;
}

export interface CanonicalVendor {
  name: string;
  email: string | null;
  is_active: boolean;
}
export interface CanonicalCustomer {
  name: string;
  legal_name: string | null;
  trade_name: string | null;
  document_digits: string | null; // server-only: hashed/masked before storing
  person_type: "PF" | "PJ" | null;
  state: string | null;
  city: string | null;
  external_seller_id: string | null;
  is_active: boolean;
}
export interface CanonicalProduct {
  sku: string | null;
  description: string;
  family: string | null;
  unit: string | null;
  is_active: boolean;
}

export interface OmieAdapter<C> {
  entity: OmieEntity;
  path: string;
  call: string;
  pageSize: number;
  listKeys: string[];
  pageParams: (page: number, pageSize: number) => Payload;
  toRaw: (p: Payload) => RawRecord | null;
  toCanonical: (p: Payload) => C;
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
/** Omie flags use "S"/"N". */
const flagS = (v: unknown): boolean => str(v)?.toUpperCase() === "S";
const obj = (v: unknown): Payload => (v && typeof v === "object" ? (v as Payload) : {});

/** Omie dates come as dd/mm/yyyy (+ optional hh:mm:ss), São Paulo time. */
export function parseOmieDate(d: unknown, h?: unknown): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str(d) ?? "");
  if (!m) return null;
  const t = /^\d{2}:\d{2}(:\d{2})?$/.test(str(h) ?? "") ? str(h)! : "00:00:00";
  return `${m[3]}-${m[2]}-${m[1]}T${t.length === 5 ? `${t}:00` : t}-03:00`;
}

const infoUpdated = (p: Payload) => {
  const info = obj(p["info"]);
  return parseOmieDate(info["dAlt"], info["hAlt"]) ?? parseOmieDate(info["dInc"], info["hInc"]);
};

export const vendorsAdapter: OmieAdapter<CanonicalVendor> = {
  entity: "vendors",
  path: "geral/vendedores/",
  call: "ListarVendedores",
  pageSize: 100,
  listKeys: ["cadastro", "vendedores_cadastro", "vendedores"],
  pageParams: (pagina, registros_por_pagina) => ({
    pagina,
    registros_por_pagina,
    apenas_importado_api: "N",
  }),
  toRaw: (p) => {
    const id = str(p["codigo"]);
    if (!id) return null;
    return {
      external_id: id,
      payload: p,
      source_updated_at: infoUpdated(p),
      is_active: !flagS(p["inativo"]),
    };
  },
  toCanonical: (p) => ({
    name: str(p["nome"]) ?? `Vendedor ${str(p["codigo"])}`,
    email: str(p["email"]),
    is_active: !flagS(p["inativo"]),
  }),
};

export const customersAdapter: OmieAdapter<CanonicalCustomer> = {
  entity: "customers",
  path: "geral/clientes/",
  call: "ListarClientes",
  pageSize: 50, // documented maximum
  listKeys: ["clientes_cadastro"],
  pageParams: (pagina, registros_por_pagina) => ({
    pagina,
    registros_por_pagina,
    apenas_importado_api: "N",
  }),
  toRaw: (p) => {
    const id = str(p["codigo_cliente_omie"]);
    if (!id) return null;
    return {
      external_id: id,
      payload: p,
      source_updated_at: infoUpdated(p),
      is_active: !flagS(p["inativo"]),
    };
  },
  toCanonical: (p) => {
    const digits = (str(p["cnpj_cpf"]) ?? "").replace(/\D/g, "");
    const legal = str(p["razao_social"]);
    const trade = str(p["nome_fantasia"]);
    const rec = obj(p["recomendacoes"]);
    return {
      name: trade ?? legal ?? `Cliente ${str(p["codigo_cliente_omie"])}`,
      legal_name: legal,
      trade_name: trade,
      document_digits: digits.length === 11 || digits.length === 14 ? digits : null,
      person_type: digits.length === 11 ? "PF" : digits.length === 14 ? "PJ" : null,
      state: str(p["estado"])?.toUpperCase() ?? null,
      city: str(p["cidade"]),
      external_seller_id: str(rec["codigo_vendedor"]),
      is_active: !flagS(p["inativo"]),
    };
  },
};

export const productsAdapter: OmieAdapter<CanonicalProduct> = {
  entity: "products",
  path: "geral/produtos/",
  call: "ListarProdutos",
  pageSize: 100,
  listKeys: ["produto_servico_cadastro"],
  pageParams: (pagina, registros_por_pagina) => ({
    pagina,
    registros_por_pagina,
    apenas_importado_api: "N",
    // Official default is S (only products configured for Omie PDV).
    filtrar_apenas_omiepdv: "N",
  }),
  toRaw: (p) => {
    const id = str(p["codigo_produto"]);
    if (!id) return null;
    return {
      external_id: id,
      payload: p,
      source_updated_at: infoUpdated(p),
      is_active: !flagS(p["inativo"]),
    };
  },
  toCanonical: (p) => ({
    sku: str(p["codigo"]),
    description: str(p["descricao"]) ?? `Produto ${str(p["codigo_produto"])}`,
    family: str(p["descricao_familia"]),
    unit: str(p["unidade"]),
    is_active: !flagS(p["inativo"]),
  }),
};

export const ADAPTERS = {
  vendors: vendorsAdapter,
  customers: customersAdapter,
  products: productsAdapter,
} as const;

/** Masked document for display: keeps only the last 2 digits. */
export function maskDocument(digits: string | null): string | null {
  if (!digits) return null;
  return digits.length === 14
    ? `**.***.***/****-${digits.slice(-2)}`
    : `***.***.***-${digits.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Transactional adapters (Fase B). Endpoints/calls follow the Omie API
// reference, but RESPONSE FIELD NAMES ARE UNCONFIRMED until validated against
// a real response (see docs/OMIE_TRANSACTIONAL_MAPPING.md). Any missing
// required field makes toRaw return null (counted as failed), never invented.
// ---------------------------------------------------------------------------

export type OmieTxEntity = "invoices" | "orders" | "receivables" | "settlements";
export type OmieAnyEntity = OmieEntity | OmieTxEntity;
export const TX_ORDER: OmieTxEntity[] = ["invoices", "orders", "receivables", "settlements"];
export const TX_LABEL: Record<OmieTxEntity, string> = {
  invoices: "Notas fiscais",
  orders: "Pedidos",
  receivables: "Contas a receber",
  settlements: "Liquidações",
};

export interface Period {
  from: string; // yyyy-mm-dd
  to: string;
}
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const day = (v: unknown) => parseOmieDate(v)?.slice(0, 10) ?? null;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface CanonicalItem {
  item_sequence: number;
  product_external_id: string | null;
  description: string | null;
  quantity: number;
  unit_price: number;
  total: number;
}
export interface TxCanonical {
  header: Record<string, unknown>;
  items?: CanonicalItem[];
}

export interface OmieTxAdapter {
  entity: OmieTxEntity;
  path: string;
  call: string;
  pageSize: number;
  listKeys: string[];
  confirmed: false;
  pageParams: (page: number, pageSize: number, period: Period) => Payload;
  toRaw: (p: Payload) => RawRecord | null;
  toCanonical: (p: Payload) => TxCanonical | null;
}

/** Items keep the source sequence; falls back to array position (1-based). */
export function mapItems(
  list: unknown,
  pick: (d: Payload, i: number) => CanonicalItem,
): CanonicalItem[] {
  const arr = Array.isArray(list) ? (list as Payload[]) : [];
  const out = arr.map((d, i) => pick(obj(d), i));
  const seen = new Set<number>();
  for (const it of out) {
    if (seen.has(it.item_sequence))
      throw new Error(`Sequência de item duplicada: ${it.item_sequence}`);
    seen.add(it.item_sequence);
  }
  return out;
}

/** Matches the proven ListarNF evidence policy in the legacy FiscalSupport
 * (classifyInvoiceFiscalStatus). An invoiced order or an access key alone never
 * proves SEFAZ authorization. Documents without positive evidence, with an
 * inutilization date or a cancelled/returned order are kept as
 * "not_authorized" (legacy "nao_autorizada"): visible, never revenue, and they
 * no longer block the whole load. Only sandbox and incoming documents are
 * excluded from the sales canonical.
 */
export type InvoiceStatus = "authorized" | "cancelled" | "denied" | "not_authorized";

function invoiceStatus(p: Payload): InvoiceStatus | null {
  const ide = obj(p["ide"]);
  const compl = obj(p["compl"]);
  const protocol = obj(obj(p["protNFe"])["infProt"]);
  const directProtocol = obj(p["infProt"]);
  const code =
    [
      protocol["cStat"],
      directProtocol["cStat"],
      compl["cStat"],
      compl["cStatus"],
      ide["cStatus"],
      p["cStat"],
      p["cStatus"],
    ]
      .map(str)
      .find((value) => value !== null)
      ?.toUpperCase() ?? null;
  // Production sales cannot acquire revenue from a sandbox or an incoming NF.
  if (
    (str(ide["tpAmb"]) !== null && str(ide["tpAmb"]) !== "1") ||
    (str(ide["tpNF"]) !== null && str(ide["tpNF"]) !== "1")
  )
    return null;
  if (
    str(ide["dCan"]) ||
    flagS(obj(p["info"])["cancelada"]) ||
    ["101", "151", "155", "CANCELADA", "CANCELADO", "C"].includes(code ?? "")
  )
    return "cancelled";
  if (str(ide["dInut"])) return "not_authorized";
  if (
    flagS(ide["cDeneg"]) ||
    ["110", "301", "302", "303", "DENEGADA", "DENEGADO", "D"].includes(code ?? "")
  )
    return "denied";
  const order = obj(p["pedido"]);
  if (flagS(order["cCancelado"]) || flagS(order["cDevolvido"]) || flagS(order["cDevParcial"]))
    return "not_authorized";
  if (code)
    return ["100", "150", "AUTORIZADA", "AUTORIZADO"].includes(code)
      ? "authorized"
      : "not_authorized";
  const key = str(compl["cChaveNFe"]);
  const authorizationProtocol = [
    protocol["nProt"],
    directProtocol["nProt"],
    compl["nProt"],
    p["nProt"],
  ]
    .map(str)
    .find(Boolean);
  return key &&
    /^\d{44}$/.test(key) &&
    day(ide["dEmi"]) &&
    (str(ide["cDeneg"])?.toUpperCase() === "N" ||
      Boolean(authorizationProtocol && /^\d{15}$/.test(authorizationProtocol)))
    ? "authorized"
    : "not_authorized";
}

/** A single seller shared by all installment titles; ambiguity stays explicit. */
function invoiceSeller(p: Payload): string | null {
  const titles = Array.isArray(p["titulos"]) ? p["titulos"] : [];
  const ids = new Set(
    [obj(p["compl"])["nCodVend"], ...titles.map((title) => obj(title)["nCodVendedor"])]
      .map(str)
      .filter((id): id is string => id !== null && id !== "0"),
  );
  return ids.size === 1 ? [...ids][0]! : null;
}

export const invoicesAdapter: OmieTxAdapter = {
  entity: "invoices",
  path: "produtos/nfconsultar/",
  call: "ListarNF",
  pageSize: 100,
  listKeys: ["nfCadastro"],
  confirmed: false,
  pageParams: (pagina, registros_por_pagina, period) => ({
    pagina,
    registros_por_pagina,
    dEmiInicial: br(period.from),
    dEmiFinal: br(period.to),
    tpAmb: "1",
    tpNF: "1",
    cApenasResumo: "N",
  }),
  toRaw: (p) => {
    const id = str(obj(p["compl"])["nIdNF"]);
    if (!id) return null;
    return { external_id: id, payload: p, source_updated_at: infoUpdated(p), is_active: null };
  },
  toCanonical: (p) => {
    const ide = obj(p["ide"]);
    const tot = obj(obj(p["total"])["ICMSTot"]);
    const compl = obj(p["compl"]);
    const competence = day(ide["dEmi"]);
    const number = str(ide["nNF"]);
    if (!competence || !number) return null;
    const status = invoiceStatus(p);
    if (!status) return null;
    return {
      header: {
        number,
        series: str(ide["serie"]),
        status,
        issue_date: competence,
        competence_date: competence,
        customer_external_id: str(obj(p["nfDestInt"])["nCodCli"]),
        seller_external_id: invoiceSeller(p),
        order_external_id: str(compl["nIdPedido"]),
        gross_amount: num(tot["vNF"]),
        goods_amount: num(tot["vProd"]),
        freight_amount: num(tot["vFrete"]),
        insurance_amount: num(tot["vSeg"]),
        other_expenses_amount: num(tot["vOutro"]),
        discount_amount: num(tot["vDesc"]),
      },
      items: mapItems(p["det"], (d, i) => {
        const prod = obj(d["prod"]);
        const ni = obj(d["nfProdInt"]);
        return {
          item_sequence: Number(str(obj(d["ide"])["nItem"]) ?? i + 1) || i + 1,
          product_external_id: str(ni["nCodProd"]),
          description: str(prod["xProd"]),
          quantity: num(prod["qCom"]),
          unit_price: num(prod["vUnCom"]),
          total: num(prod["vProd"]),
        };
      }),
    };
  },
};

export const ordersAdapter: OmieTxAdapter = {
  entity: "orders",
  path: "produtos/pedido/",
  call: "ListarPedidos",
  pageSize: 100,
  listKeys: ["pedido_venda_produto"],
  confirmed: false,
  pageParams: (pagina, registros_por_pagina, period) => ({
    pagina,
    registros_por_pagina,
    apenas_importado_api: "N",
    filtrar_por_data_de: br(period.from),
    filtrar_por_data_ate: br(period.to),
  }),
  toRaw: (p) => {
    const id = str(obj(p["cabecalho"])["codigo_pedido"]);
    if (!id) return null;
    return { external_id: id, payload: p, source_updated_at: infoUpdated(p), is_active: null };
  },
  toCanonical: (p) => {
    const cab = obj(p["cabecalho"]);
    const info = obj(p["infoCadastro"]);
    const date = day(info["dInc"]) ?? day(cab["data_previsao"]);
    const number = str(cab["numero_pedido"]) ?? str(cab["codigo_pedido"]);
    if (!date || !number) return null;
    const etapa = str(cab["etapa"]);
    const status = flagS(info["cancelado"])
      ? "cancelled"
      : flagS(info["faturado"]) || etapa === "60"
        ? "invoiced"
        : "open";
    return {
      header: {
        number,
        status,
        order_date: date,
        expected_date: day(cab["data_previsao"]),
        customer_external_id: str(cab["codigo_cliente"]),
        seller_external_id: str(obj(p["informacoes_adicionais"])["codVend"]),
        total: num(obj(p["total_pedido"])["valor_total_pedido"]),
      },
      items: mapItems(p["det"], (d, i) => {
        const prod = obj(d["produto"]);
        return {
          // det[].ide.codigo_item is Omie's internal item id (e.g. 7470859144), not
          // a sequence; the position in the order is the stable sequence.
          item_sequence: i + 1,
          product_external_id: str(prod["codigo_produto"]),
          description: str(prod["descricao"]),
          quantity: num(prod["quantidade"]),
          unit_price: num(prod["valor_unitario"]),
          total: num(prod["valor_total"]),
        };
      }),
    };
  },
};

export const receivablesAdapter: OmieTxAdapter = {
  entity: "receivables",
  path: "financas/contareceber/",
  call: "ListarContasReceber",
  pageSize: 100,
  listKeys: ["conta_receber_cadastro"],
  confirmed: false,
  pageParams: (pagina, registros_por_pagina, period) => ({
    pagina,
    registros_por_pagina,
    apenas_importado_api: "N",
    filtrar_por_emissao_de: br(period.from),
    filtrar_por_emissao_ate: br(period.to),
  }),
  toRaw: (p) => {
    const id = str(p["codigo_lancamento_omie"]);
    if (!id) return null;
    return { external_id: id, payload: p, source_updated_at: infoUpdated(p), is_active: null };
  },
  toCanonical: (p) => {
    const due = day(p["data_vencimento"]);
    if (!due) return null;
    const parc = /^(\d+)\/(\d+)$/.exec(str(p["numero_parcela"]) ?? "");
    const status = str(p["status_titulo"]);
    return {
      header: {
        document_number:
          str(p["numero_documento_fiscal"]) ??
          str(p["numero_documento"]) ??
          str(p["codigo_lancamento_omie"]),
        installment: parc ? Number(parc[1]) : 1,
        installments: parc ? Number(parc[2]) : 1,
        customer_external_id: str(p["codigo_cliente_fornecedor"]),
        seller_external_id: str(p["codigo_vendedor"]),
        invoice_external_id: str(p["nCodNF"]),
        issue_date: day(p["data_emissao"]),
        competence_date: day(p["data_registro"]) ?? day(p["data_emissao"]),
        due_date: due,
        expected_date: day(p["data_previsao"]),
        original_amount: num(p["valor_documento"]),
        source_status: status,
        cancelled_at:
          status?.toUpperCase() === "CANCELADO" ? (day(p["data_emissao"]) ?? due) : null,
        category_code: str(p["codigo_categoria"]),
        account_external_id: str(p["id_conta_corrente"]),
      },
    };
  },
};

export const settlementsAdapter: OmieTxAdapter = {
  entity: "settlements",
  path: "financas/mf/",
  call: "ListarMovimentos",
  pageSize: 50,
  listKeys: ["movimentos"],
  confirmed: false,
  pageParams: (nPagina, nRegPorPagina, period) => ({
    nPagina,
    nRegPorPagina,
    cNatureza: "R",
    cTpLancamento: "BXCR",
    dDtPagtoDe: br(period.from),
    dDtPagtoAte: br(period.to),
  }),
  toRaw: (p) => {
    const det = obj(p["detalhes"]);
    const id = str(det["nCodBaixa"]) ?? null;
    if (!id || !/^\d+$/.test(id) || /^0+$/.test(id)) return null;
    return { external_id: id, payload: p, source_updated_at: null, is_active: null };
  },
  toCanonical: (p) => {
    const det = obj(p["detalhes"]);
    const date = day(det["dDtPagamento"]);
    const title = str(det["nCodTitulo"]);
    const movementAmount = det["nValorMovCC"];
    // resumo.nValPago is cumulative per title. It cannot be repeated for every
    // nCodBaixa without double-counting partial receipts.
    if (
      !date ||
      !title ||
      !settlementsAdapter.toRaw(p) ||
      movementAmount === null ||
      movementAmount === undefined ||
      movementAmount === "" ||
      !Number.isFinite(Number(movementAmount)) ||
      Number(movementAmount) <= 0 ||
      (str(det["cNatureza"]) !== null && str(det["cNatureza"]) !== "R") ||
      str(det["cStatus"])?.toUpperCase() === "CANCELADO"
    )
      return null;
    return {
      header: {
        receivable_external_id: title,
        settlement_date: date,
        amount: Number(movementAmount),
        account_external_id: str(det["nCodCC"]),
      },
    };
  },
};

export const TX_ADAPTERS: Record<OmieTxEntity, OmieTxAdapter> = {
  invoices: invoicesAdapter,
  orders: ordersAdapter,
  receivables: receivablesAdapter,
  settlements: settlementsAdapter,
};

/** Splits a from/to range into month partitions (month is a strategy, not a limit). */
export function monthPartitions(period: Period): Period[] {
  const validDate = (iso: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const timestamp = Date.parse(`${iso}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso;
  };
  if (!validDate(period.from) || !validDate(period.to) || period.from > period.to)
    throw new Error("Período inválido: informe datas reais em YYYY-MM-DD.");
  const out: Period[] = [];
  let y = Number(period.from.slice(0, 4));
  let m = Number(period.from.slice(5, 7));
  for (;;) {
    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${y}-${String(m).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
    const from = start < period.from ? period.from : start;
    const to = end > period.to ? period.to : end;
    if (from > period.to) break;
    out.push({ from, to });
    if (to >= period.to) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
