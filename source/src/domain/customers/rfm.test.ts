import { describe, expect, it } from "vitest";
import { computeRfm, resolveRfmConfig, DEFAULT_RFM_CONFIG } from "./rfm";
import { maskDocument } from "@/domain/format";

describe("RFM", () => {
  it("scores bands deterministically", () => {
    expect(computeRfm({ recencyDays: 10, frequency: 12, monetary: 400_000 })).toMatchObject({
      code: "555",
      segment: "CHAMPIONS",
    });
    expect(computeRfm({ recencyDays: 300, frequency: 1, monetary: 1_000 })).toMatchObject({
      code: "111",
      segment: "LOST",
    });
    expect(computeRfm({ recencyDays: 90, frequency: 4, monetary: 60_000 })?.code).toBe("333");
  });
  it("band edges: recency ≤ cut stays in better band; frequency ≥ cut moves up", () => {
    expect(computeRfm({ recencyDays: 30, frequency: 2, monetary: 0 })?.r).toBe(5);
    expect(computeRfm({ recencyDays: 31, frequency: 2, monetary: 0 })?.r).toBe(4);
    expect(computeRfm({ recencyDays: 31, frequency: 2, monetary: 0 })?.f).toBe(2);
  });
  it("returns null without purchase history", () => {
    expect(computeRfm({ recencyDays: null, frequency: 0, monetary: 0 })).toBeNull();
  });
  it("merges config safely", () => {
    expect(resolveRfmConfig({ recency: [1, 2] })).toEqual(DEFAULT_RFM_CONFIG);
    expect(resolveRfmConfig({ recency: [1, 2, 3, 4] }).recency).toEqual([1, 2, 3, 4]);
  });
});

describe("maskDocument", () => {
  it("masks CNPJ and CPF", () => {
    expect(maskDocument("65364999000124")).toBe("65.***.***/0001-**");
    expect(maskDocument("12345678901")).toBe("***.456.***-**");
    expect(maskDocument(null)).toBe("—");
  });
});
