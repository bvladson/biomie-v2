import { describe, expect, it } from "vitest";
import {
  invoicesAdapter,
  productsAdapter,
  receivablesAdapter,
  settlementsAdapter,
} from "./adapters";

// Structure observed in ListarNF; all identifiers/amounts below are synthetic.
const invoice = () => ({
  ide: {
    nNF: "123",
    serie: "1",
    dEmi: "19/10/2026",
    dReg: "19/10/2026",
    dCan: "",
    dInut: "",
    cDeneg: "N",
    tpAmb: "1",
    tpNF: "1",
  },
  compl: { nIdNF: 1, nIdPedido: 2, nIdReceb: 3, cChaveNFe: "1".repeat(44) },
  nfDestInt: { nCodCli: 9 },
  titulos: [{ nCodVendedor: 5 }, { nCodVendedor: 5 }],
  total: { ICMSTot: { vNF: 1150, vProd: 1000, vFrete: 100, vSeg: 20, vOutro: 40, vDesc: 10 } },
  det: [
    { prod: { xProd: "A", qCom: 2, vUnCom: 300, vProd: 600 }, nfProdInt: { nCodProd: 44 } },
    { prod: { xProd: "B", qCom: 1, vUnCom: 400, vProd: 400 }, nfProdInt: { nCodProd: 45 } },
  ],
});

describe("observed ListarNF payload", () => {
  it("recognizes the legacy positive evidence without inventing cStatus", () => {
    const canonical = invoicesAdapter.toCanonical(invoice());
    expect(canonical?.header).toMatchObject({
      status: "authorized",
      seller_external_id: "5",
      customer_external_id: "9",
      gross_amount: 1150,
    });
    expect(canonical?.items?.map((item) => item.item_sequence)).toEqual([1, 2]);
  });

  it("never treats a key or non-denegated flag alone as authorization", () => {
    const missingFlag = invoice();
    missingFlag.ide.cDeneg = "";
    expect(invoicesAdapter.toCanonical(missingFlag)).toBeNull();
    const shortKey = invoice();
    shortKey.compl.cChaveNFe = "123";
    expect(invoicesAdapter.toCanonical(shortKey)).toBeNull();
    expect(
      invoicesAdapter.toCanonical({
        ide: { nNF: "123", dEmi: "19/10/2026" },
        pedido: { faturado: "S" },
      }),
    ).toBeNull();
  });

  it("gives cancellation, denial and inutilization precedence over positive evidence", () => {
    const cancelled = invoice();
    cancelled.ide.dCan = "20/10/2026";
    expect(invoicesAdapter.toCanonical(cancelled)?.header["status"]).toBe("cancelled");
    const denied = invoice();
    denied.ide.cDeneg = "S";
    expect(invoicesAdapter.toCanonical(denied)?.header["status"]).toBe("denied");
    const invalidated = invoice();
    invalidated.ide.dInut = "20/10/2026";
    expect(invoicesAdapter.toCanonical(invalidated)).toBeNull();
  });

  it("does not assign an arbitrary seller when installments disagree", () => {
    const conflicting = invoice();
    conflicting.titulos[1]!.nCodVendedor = 6;
    expect(invoicesAdapter.toCanonical(conflicting)?.header["seller_external_id"]).toBeNull();
  });

  it("keeps incoming or homologation documents out of sales canonical", () => {
    const sandbox = invoice();
    sandbox.ide.tpAmb = "2";
    const incoming = invoice();
    incoming.ide.tpNF = "0";
    expect(invoicesAdapter.toCanonical(sandbox)).toBeNull();
    expect(invoicesAdapter.toCanonical(incoming)).toBeNull();
  });
});

describe("documented Omie request parameters", () => {
  it("does not silently use the PDV-only default for the product catalog", () => {
    expect(productsAdapter.pageParams(1, 100)).toMatchObject({
      apenas_importado_api: "N",
      filtrar_apenas_omiepdv: "N",
    });
  });
  it("requests actual receivable settlements and uses the exact payment filter names", () => {
    expect(settlementsAdapter.pageSize).toBe(50);
    expect(settlementsAdapter.pageParams(2, 50, { from: "2026-10-01", to: "2026-10-19" })).toEqual({
      nPagina: 2,
      nRegPorPagina: 50,
      cNatureza: "R",
      cTpLancamento: "BXCR",
      dDtPagtoDe: "01/10/2026",
      dDtPagtoAte: "19/10/2026",
    });
  });
});

describe("settlement amounts", () => {
  const movement = () => ({
    detalhes: {
      nCodBaixa: 7,
      nCodTitulo: 8,
      nCodCC: 9,
      dDtPagamento: "19/10/2026",
      cNatureza: "R",
      nValorMovCC: 100,
    },
    resumo: { nValPago: 500 },
  });
  it("uses the amount of this movement instead of the cumulative paid title amount", () => {
    const payload = movement();
    expect(settlementsAdapter.toRaw(payload)?.external_id).toBe("7");
    expect(settlementsAdapter.toCanonical(payload)?.header["amount"]).toBe(100);
  });
  it("does not invent the receipt amount when only a cumulative title summary exists", () => {
    const payload = {
      detalhes: { nCodBaixa: 7, nCodTitulo: 8, dDtPagamento: "19/10/2026" },
      resumo: { nValPago: 500 },
    };
    expect(settlementsAdapter.toCanonical(payload)).toBeNull();
  });
  it("does not use a zero baixa identifier as a receipt identity", () => {
    const payload = movement();
    payload.detalhes.nCodBaixa = 0;
    expect(settlementsAdapter.toRaw(payload)).toBeNull();
    expect(settlementsAdapter.toCanonical(payload)).toBeNull();
  });
});

describe("observed ListarContasReceber fields", () => {
  it("uses the fiscal document number and preserves title identity", () => {
    const payload = {
      codigo_lancamento_omie: 77,
      numero_documento_fiscal: "NF-123",
      data_vencimento: "20/10/2026",
      valor_documento: 100,
      chave_nfe: "1".repeat(44),
      nCodPedido: 88,
    };
    expect(receivablesAdapter.toRaw(payload)?.external_id).toBe("77");
    expect(receivablesAdapter.toCanonical(payload)?.header).toMatchObject({
      document_number: "NF-123",
      invoice_external_id: null,
    });
  });
  it("retains a valid legacy document number and finally the external title ID", () => {
    const payload = {
      codigo_lancamento_omie: 77,
      data_vencimento: "20/10/2026",
      valor_documento: 100,
    };
    expect(
      receivablesAdapter.toCanonical({ ...payload, numero_documento: "DOC-77" })?.header[
        "document_number"
      ],
    ).toBe("DOC-77");
    expect(receivablesAdapter.toCanonical(payload)?.header["document_number"]).toBe("77");
  });
});
