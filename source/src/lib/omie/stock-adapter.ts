/**
 * Estoque no Omie — funções puras (parâmetros e conversão de cada registro).
 *
 * estoque/consulta:ListarPosEstoque (posição por produto e local, com CMC) e
 * estoque/local:ListarLocaisEstoque (nome de cada local). Campos conferidos na referência
 * oficial em 21/10/2026: nCodProd, cCodigo, cDescricao, nPrecoUnitario, nSaldo, nCMC,
 * nPendente, estoque_minimo, codigo_local_estoque, reservado, fisico; e, nos locais,
 * codigo_local_estoque, codigo, descricao, tipo, padrao, inativo, dispVenda.
 *
 * Regras herdadas do projeto MAG_Estoque_Omie: quantidade física = `fisico` (ou `nSaldo` se
 * faltar), custo = CMC, reservado e pendente à parte (nunca descontados), saldo negativo
 * preservado, limite de 20.000 posições sem publicação parcial.
 */

export const STOCK_PATH = "estoque/consulta/";
export const STOCK_CALL = "ListarPosEstoque";
export const STOCK_LIST_KEYS = ["produtos"];
export const STOCK_PAGE_SIZE = 100;
/** 200 páginas de 100 = 20.000 posições, o mesmo teto do projeto de origem. */
export const MAX_STOCK_PAGES = 200;

export const LOCATIONS_PATH = "estoque/local/";
export const LOCATIONS_CALL = "ListarLocaisEstoque";
export const LOCATIONS_LIST_KEYS = ["locaisEncontrados"];
export const LOCATIONS_PAGE_SIZE = 50;
export const MAX_LOCATION_PAGES = 20;

export interface StockRow {
  omie_product_id: string;
  location_code: string;
  sku: string;
  name: string;
  physical_qty: number;
  balance_qty: number | null;
  reserved_qty: number;
  pending_qty: number;
  min_qty: number | null;
  unit_cost: number;
  sale_price: number;
}

export interface StockLocation {
  name: string | null;
  code: string | null;
  type: string | null;
  defaultLocation: boolean;
  forSale: boolean | null;
  inactive: boolean;
}

/** Dado do Omie que não pode ser gravado: tentar de novo não resolve. */
export class StockRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockRecordError";
  }
}

/** "DD/MM/AAAA", como o Omie espera em dDataPosicao. */
export function isOmieDate(value: string): boolean {
  return /^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/.test(value);
}

export function stockPageParams(page: number, positionDate: string): Record<string, unknown> {
  if (!Number.isInteger(page) || page < 1 || page > MAX_STOCK_PAGES)
    throw new StockRecordError(
      "Esta leitura passou de 20.000 posições de estoque; nada foi publicado.",
    );
  if (!isOmieDate(positionDate)) throw new StockRecordError("Data da posição inválida.");
  return {
    nPagina: page,
    nRegPorPagina: STOCK_PAGE_SIZE,
    dDataPosicao: positionDate,
    cExibeTodos: "S",
    lista_local_estoque: "TODOS",
  };
}

export function locationsPageParams(page: number): Record<string, unknown> {
  return { nPagina: page, nRegPorPagina: LOCATIONS_PAGE_SIZE };
}

const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
};

function amount(
  value: unknown,
  field: string,
  options: { optional?: boolean; signed?: boolean } = {},
): number | null {
  if (value === undefined || value === null || value === "") {
    if (options.optional) return null;
    throw new StockRecordError(`O Omie devolveu ${field} vazio.`);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e12 || (!options.signed && n < 0))
    throw new StockRecordError(`O Omie devolveu ${field} inválido.`);
  return n;
}

/** Um item de `produtos` do ListarPosEstoque na linha gravada pelo worker. */
export function toStockRow(p: Record<string, unknown>): StockRow {
  const product = text(p["nCodProd"]);
  if (!product || !/^\d+$/.test(product))
    throw new StockRecordError("O Omie devolveu uma posição sem identificador de produto.");
  const local = text(p["codigo_local_estoque"]);
  if (local !== null && !/^\d+$/.test(local))
    throw new StockRecordError("O Omie devolveu um código de local de estoque inválido.");
  const physical = amount(p["fisico"] ?? p["nSaldo"], "quantidade de estoque", { signed: true })!;
  return {
    omie_product_id: product,
    location_code: local ?? "total",
    sku: (text(p["cCodigo"]) ?? product).slice(0, 80),
    name: (text(p["cDescricao"]) ?? text(p["cCodigo"]) ?? product).slice(0, 150),
    physical_qty: physical,
    balance_qty: amount(p["nSaldo"], "saldo", { optional: true, signed: true }),
    reserved_qty:
      amount(p["reservado"], "quantidade reservada", { optional: true, signed: true }) ?? 0,
    pending_qty: amount(p["nPendente"], "pedidos pendentes", { optional: true, signed: true }) ?? 0,
    min_qty: amount(p["estoque_minimo"], "estoque mínimo", { optional: true }),
    unit_cost: amount(p["nCMC"], "custo médio contábil")!,
    sale_price: amount(p["nPrecoUnitario"], "preço de venda", { optional: true }) ?? 0,
  };
}

const flag = (value: unknown) => text(value)?.toUpperCase() === "S";

/** Um item de `locaisEncontrados` como [código, local]; registros sem código ficam de fora. */
export function toLocationEntry(l: Record<string, unknown>): [string, StockLocation] | null {
  const code = text(l["codigo_local_estoque"]);
  if (!code || !/^\d+$/.test(code)) return null;
  const forSale = text(l["dispVenda"]);
  return [
    code,
    {
      name: text(l["descricao"])?.slice(0, 120) ?? null,
      code: text(l["codigo"])?.slice(0, 50) ?? null,
      type: text(l["tipo"]),
      defaultLocation: flag(l["padrao"]),
      forSale: forSale === null ? null : forSale.toUpperCase() === "S",
      inactive: flag(l["inativo"]),
    },
  ];
}
