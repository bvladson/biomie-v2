import { describe, expect, it } from "vitest";
import {
  applyPaste,
  buildChanges,
  cellKey,
  copyPrevious,
  initialDraft,
  levelWarnings,
  parseAmount,
  parseClipboard,
  totals,
  type GridSeller,
} from "./grid";

const seller = (id: string, overrides: Partial<GridSeller> = {}): GridSeller => ({
  id,
  name: `Vendedor ${id}`,
  team: null,
  active: true,
  editable: true,
  targets: {},
  previous: {},
  ...overrides,
});

describe("parseAmount", () => {
  it("reads the formats people type and paste in Brazil", () => {
    expect(parseAmount("350.000,00")).toBe(350000);
    expect(parseAmount("R$ 350.000")).toBe(350000);
    expect(parseAmount("350000")).toBe(350000);
    expect(parseAmount("350000,5")).toBe(350000.5);
    expect(parseAmount("350000.50")).toBe(350000.5);
    expect(parseAmount("1.234.567,891")).toBe(1234567.89);
    expect(parseAmount("1,234,567")).toBe(1234567);
    expect(parseAmount("12 500,00")).toBe(12500);
  });
  it("treats empty as no target and anything else as invalid", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
    expect(parseAmount("abc")).toBeNaN();
    expect(parseAmount("12a")).toBeNaN();
    expect(parseAmount(",")).toBeNaN();
  });
});

describe("parseClipboard", () => {
  it("splits a block copied from Excel, ignoring the trailing line break", () => {
    expect(parseClipboard("100\t200\t300\r\n400\t500\t600\r\n")).toEqual([
      ["100", "200", "300"],
      ["400", "500", "600"],
    ]);
    expect(parseClipboard("")).toEqual([]);
  });
});

describe("applyPaste", () => {
  it("fills from the clicked cell to the right and down, skipping read-only rows", () => {
    const sellers = [seller("a"), seller("b", { editable: false }), seller("c")];
    const result = applyPaste(sellers, initialDraft(sellers), 0, 1, [
      ["10", "20", "30"],
      ["40", "50"],
      ["60"],
    ]);
    expect(result.draft[cellKey("a", "ACTIVE")]).toBe("10");
    expect(result.draft[cellKey("a", "CHALLENGE")]).toBe("20");
    expect(result.draft[cellKey("b", "ACTIVE")]).toBe("");
    expect(result.draft[cellKey("c", "ACTIVE")]).toBe("60");
    // "30" falls beyond the last level; the two cells of the read-only row are skipped.
    expect(result).toMatchObject({ applied: 3, skipped: 3 });
  });
});

describe("buildChanges", () => {
  it("sends only real changes, clears with null and never sends invalid cells", () => {
    const sellers = [
      seller("a", { targets: { ACTIVE: 100000, BASE: 80000 } }),
      seller("b", { editable: false, targets: { ACTIVE: 5 } }),
    ];
    const draft = initialDraft(sellers);
    draft[cellKey("a", "ACTIVE")] = "100.000,00"; // same value, other format
    draft[cellKey("a", "BASE")] = ""; // cleared
    draft[cellKey("a", "CHALLENGE")] = "120.000"; // new
    draft[cellKey("b", "ACTIVE")] = "9"; // read-only row: ignored
    expect(buildChanges(sellers, draft)).toEqual({
      changes: [
        { seller: "a", level: "BASE", amount: null },
        { seller: "a", level: "CHALLENGE", amount: 120000 },
      ],
      errors: [],
    });
    draft[cellKey("a", "CHALLENGE")] = "-1";
    draft[cellKey("a", "BASE")] = "dez";
    expect(buildChanges(sellers, draft).errors).toEqual([
      { key: cellKey("a", "BASE"), message: "Valor inválido" },
      { key: cellKey("a", "CHALLENGE"), message: "Meta não pode ser negativa" },
    ]);
  });
});

describe("copyPrevious, totals and warnings", () => {
  it("copies last month only into empty editable cells", () => {
    const sellers = [
      seller("a", { previous: { ACTIVE: 1000, BASE: 800 }, targets: { BASE: 900 } }),
      seller("b", { editable: false, previous: { ACTIVE: 50 } }),
    ];
    const { draft, filled } = copyPrevious(sellers, initialDraft(sellers));
    expect(filled).toBe(1);
    expect(draft[cellKey("a", "ACTIVE")]).toBe("1.000,00");
    expect(draft[cellKey("a", "BASE")]).toBe("900,00");
    expect(draft[cellKey("b", "ACTIVE")]).toBe("");
    expect(totals(sellers, draft)).toEqual({ BASE: 900, ACTIVE: 1000, CHALLENGE: 0 });
  });
  it("warns when the levels are out of order", () => {
    const draft = {
      [cellKey("a", "BASE")]: "200",
      [cellKey("a", "ACTIVE")]: "100",
      [cellKey("a", "CHALLENGE")]: "50",
    };
    expect(levelWarnings(draft, "a")).toEqual(["Base acima da Ativa", "Ativa acima do Desafio"]);
    expect(levelWarnings({ [cellKey("a", "ACTIVE")]: "100" }, "a")).toEqual([]);
  });
});
