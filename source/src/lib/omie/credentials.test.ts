import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_PREFIX,
  credentialAad,
  credentialsKey,
  decryptCredential,
  encryptCredential,
  encryptOmieCredentials,
  isEncryptedCredential,
  keyHint,
  loadOmieCredentials,
} from "./credentials.server";

const key = randomBytes(32);
const company = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

describe("Omie credential encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const aad = credentialAad(company, "omie", "app_secret");
    const value = encryptCredential("segredo-omie", aad, key);
    expect(value.startsWith(CREDENTIAL_PREFIX)).toBe(true);
    expect(value).not.toContain("segredo-omie");
    expect(decryptCredential(value, aad, key)).toBe("segredo-omie");
  });

  it("uses a fresh nonce for each encryption", () => {
    const aad = credentialAad(company, "omie", "app_key");
    expect(encryptCredential("123", aad, key)).not.toBe(encryptCredential("123", aad, key));
  });

  it("binds ciphertext to company and field (cannot be moved to another row)", () => {
    const value = encryptCredential("segredo", credentialAad(company, "omie", "app_secret"), key);
    expect(() => decryptCredential(value, credentialAad(other, "omie", "app_secret"), key)).toThrow(
      /decifrar/,
    );
    expect(() => decryptCredential(value, credentialAad(company, "omie", "app_key"), key)).toThrow(
      /decifrar/,
    );
  });

  it("detects tampering and wrong keys without echoing data", () => {
    const aad = credentialAad(company, "omie", "app_secret");
    const value = encryptCredential("segredo", aad, key);
    const tampered = value.slice(0, -2) + (value.endsWith("A") ? "BB" : "AA");
    expect(() => decryptCredential(tampered, aad, key)).toThrow(/decifrar/);
    try {
      decryptCredential(value, aad, randomBytes(32));
    } catch (error) {
      expect(String(error)).not.toContain("segredo");
      expect(String(error)).not.toContain(value);
    }
  });

  it("refuses plaintext stored values", () => {
    expect(() =>
      decryptCredential("plain", credentialAad(company, "omie", "app_key"), key),
    ).toThrow(/recifragem/);
    expect(isEncryptedCredential("plain")).toBe(false);
  });

  it("requires a 32-byte hex key from the server environment", () => {
    expect(() => credentialsKey({})).toThrow();
    expect(() => credentialsKey({ BIOMIE_CREDENTIALS_KEY: "abc" })).toThrow();
    expect(credentialsKey({ BIOMIE_CREDENTIALS_KEY: "ab".repeat(32) })).toHaveLength(32);
  });

  it("produces the masked hint accepted by the database", () => {
    expect(keyHint("1234567890123")).toBe("••••0123");
    const encrypted = encryptOmieCredentials(company, "1234567890123", "segredo", key);
    expect(encrypted.hint).toMatch(/^••••[A-Za-z0-9]{1,4}$/);
    expect(JSON.stringify(encrypted)).not.toContain("segredo");
  });

  it("loads and decrypts only through the service RPC", async () => {
    const encrypted = encryptOmieCredentials(company, "1234567890123", "segredo", key);
    const rpc = vi.fn(async () => ({
      data: [{ app_key: encrypted.appKeyEnc, app_secret: encrypted.appSecretEnc }],
      error: null,
    }));
    await expect(loadOmieCredentials({ rpc } as never, company, key)).resolves.toEqual({
      appKey: "1234567890123",
      appSecret: "segredo",
    });
    expect(rpc).toHaveBeenCalledWith("get_integration_credentials", {
      p_company: company,
      p_provider: "omie",
    });
  });
});
