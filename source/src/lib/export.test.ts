import { describe, expect, it } from "vitest";
import { exportName, toCsv } from "./export";

describe("CSV export", () => {
  it("uses ; separator, decimal comma, BOM and escaping", () => {
    const csv = toCsv(
      [{ a: 'X; "y"', b: 1.5 }],
      [
        { header: "A", value: (r) => r.a },
        { header: "B", value: (r) => r.b },
      ],
    );
    expect(csv).toBe('\uFEFFA;B\r\n"X; ""y""";1,5');
  });
  it("encodes filters in the file name", () => {
    expect(exportName("notas", { period: "2026-10", category: "Mesas", seller: "x" })).toBe(
      "biomie_notas_2026-10_vendedor_Mesas",
    );
  });
  it("escapes spreadsheet formulas from text while preserving negative numbers", () => {
    const csv = toCsv(
      [
        { text: "=HYPERLINK(1)", amount: -12.5 },
        { text: " +1", amount: 0 },
      ],
      [
        { header: "Texto", value: (row) => row.text },
        { header: "Valor", value: (row) => row.amount },
      ],
    );
    expect(csv).toBe("\uFEFFTexto;Valor\r\n'=HYPERLINK(1);-12,5\r\n' +1;0");
  });
});
