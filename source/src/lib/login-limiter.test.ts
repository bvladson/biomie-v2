import { describe, expect, it } from "vitest";
import { createLoginLimiter } from "./login-limiter.server";

describe("Password sign-in rate limit", () => {
  it("limits attempts per client and recovers after the fixed window", () => {
    const allowed = createLoginLimiter(2, 1000);
    expect(allowed("client-a", 0)).toBe(true);
    expect(allowed("client-a", 1)).toBe(true);
    expect(allowed("client-a", 2)).toBe(false);
    expect(allowed("client-b", 2)).toBe(true);
    expect(allowed("client-a", 1000)).toBe(true);
  });

  it("keeps memory bounded without evicting active limits", () => {
    const allowed = createLoginLimiter(1, 1000, 1);
    expect(allowed("client-a", 0)).toBe(true);
    expect(allowed("client-b", 1)).toBe(false);
    expect(allowed("client-b", 1000)).toBe(true);
  });
});
