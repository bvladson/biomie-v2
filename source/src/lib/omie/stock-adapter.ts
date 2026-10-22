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
/**
 * Pedimos 100 por página, mas o Omie devolve no máximo 50 em ListarPosEstoque e calcula o
 * total de páginas com 50 (sonda nas 5 empresas em 22/10/2026). A leitura segue as páginas que
 * o Omie declara, então o tamanho real não muda o resultado. Pedir 100 mantém o pedido
 * diferente dos serviços do site da MAG (50 e 49), que usam a mesma chave do Omie: pedidos
 * idênticos em menos de 60 s colidem como "consumo redundante".
 */
export const STOCK_PAGE_SIZE = 100;
export const OMIE_STOCK_PAGE_CAP = 50;
/** Teto do projeto de origem: 20.000 posições, sem publicação parcial. */
export const MAX_STOCK_POSITIONS = 20_000;
/** 400 páginas de 50 = 20.000 posições. */
export const MAX_STOCK_PAGES = MAX_STOCK_POSITIONS / OMIE_STOCK_PAGE_CAP;

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

/** Total declarado pelo Omie acima do teto: encerra já na primeira página, sem gastar chamadas. */
export function checkStockTotal(declared: number): void {
  if (declared > MAX_STOCK_POSITIONS)
    throw new StockRecordError(
      `O Omie informou ${declared.toLocaleString("pt-BR")} posições de estoque, acima do limite de 20.000; nada foi publicado.`,
    );
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

// ===================================================================== movimentações (0043)

/**
 * estoque/consulta:ListarMovimentoEstoque — entradas e saídas por período (documentação do Omie,
 * 22/10/2026): idMov, dtMov, tipo (entrada/saida), operacao (00 ajuste, 11 venda, 13 devolução de
 * venda, 14 remessa, 21 compra, 22 importação, 23 devolução ao fornecedor, 24 retorno de remessa,
 * 28 ordem de produção...), cancelamento e devolucao (S/N), idProd (= nCodProd), qtde, cmc, valor.
 * Base da última entrada e da chegada do produto. Registro sem identificador, data, tipo ou
 * produto é pulado e contado (não trava a carga de meses).
 */
export const MOVEMENTS_PATH = "estoque/consulta/";
export const MOVEMENTS_CALL = "ListarMovimentoEstoque";
export const MOVEMENTS_LIST_KEYS = ["movProdutoListar"];
export const MOVEMENTS_PAGE_SIZE = 100;
export const MAX_MOVEMENT_PAGES = 2000;

export interface MovementRow {
  movement_id: number;
  moved_on: string; // AAAA-MM-DD
  kind: "entrada" | "saida";
  operation: string | null;
  origin: string | null;
  canceled: boolean;
  is_return: boolean;
  omie_product_id: string;
  location_code: string | null;
  qty: number | null;
  unit_cost: number | null;
  value: number | null;
  document: string | null;
}

export function movementsPageParams(
  page: number,
  from: string,
  to: string,
): Record<string, unknown> {
  if (!Number.isInteger(page) || page < 1 || page > MAX_MOVEMENT_PAGES)
    throw new StockRecordError("Período de movimentações grande demais; divida em blocos menores.");
  if (!isOmieDate(from) || !isOmieDate(to)) throw new StockRecordError("Período inválido.");
  return {
    nPagina: page,
    nRegPorPagina: MOVEMENTS_PAGE_SIZE,
    dDtInicial: from,
    dDtFinal: to,
    lista_local_estoque: "TODOS",
  };
}

/** "DD/MM/AAAA" ou "AAAA-MM-DD" → "AAAA-MM-DD"; qualquer outra coisa → null. */
export function toIsoDate(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const looseNumber = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && Math.abs(n) <= 1e12 ? n : null;
};

/** Um item de movProdutoListar; null quando não dá para gravar (pulado e contado). */
export function toMovementRow(m: Record<string, unknown>): MovementRow | null {
  const id = text(m["idMov"]);
  const product = text(m["idProd"]);
  const date = toIsoDate(m["dtMov"]);
  const tipo = text(m["tipo"]);
  const kind = tipo ? plain(tipo) : null;
  if (
    !id ||
    !/^\d{1,18}$/.test(id) ||
    !product ||
    !/^\d+$/.test(product) ||
    product === "0" ||
    !date
  )
    return null;
  if (kind !== "entrada" && kind !== "saida") return null;
  const local = text(m["codigo_local_estoque"]);
  const operation = text(m["operacao"]);
  return {
    movement_id: Number(id),
    moved_on: date,
    kind,
    operation: operation && /^\d{1,3}$/.test(operation) ? operation.padStart(2, "0") : null,
    origin: text(m["desOrigem"])?.slice(0, 50) ?? null,
    canceled: flag(m["cancelamento"]),
    is_return: flag(m["devolucao"]),
    omie_product_id: product,
    location_code: local && /^\d+$/.test(local) && local !== "0" ? local : null,
    qty: looseNumber(m["qtde"]),
    unit_cost: looseNumber(m["cmc"]),
    value: looseNumber(m["valor"]),
    document: text(m["numDoc"])?.slice(0, 20) ?? null,
  };
}
