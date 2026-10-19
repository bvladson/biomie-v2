/**
 * Omie credentials at rest: AES-256-GCM application-level encryption.
 *
 * - The key (BIOMIE_CREDENTIALS_KEY, 64 hex chars) lives only in the server
 *   environment of the web/worker containers, never in the database, the
 *   frontend bundle, test fixtures or logs.
 * - Each ciphertext is bound to company + provider + field through the GCM
 *   additional data, so a value cannot be moved to another company.
 * - Database dumps and backups therefore contain only ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { OmieError, type OmieCredentials } from "./omie-client";

export const CREDENTIAL_PREFIX = "enc:v1:";
export type CredentialField = "app_key" | "app_secret";

export function credentialsKey(env: Record<string, string | undefined> = process.env): Buffer {
  const hex = env["BIOMIE_CREDENTIALS_KEY"]?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error("Chave de cifragem das credenciais ausente ou inválida no servidor.");
  return Buffer.from(hex, "hex");
}

export const credentialAad = (company: string, provider: string, field: CredentialField) =>
  `biomie:${company}:${provider}:${field}`;

export const isEncryptedCredential = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(CREDENTIAL_PREFIX);

export function encryptCredential(plain: string, aad: string, key: Buffer): string {
  if (!plain) throw new Error("Credencial vazia.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    CREDENTIAL_PREFIX + [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(":")
  );
}

export function decryptCredential(value: string, aad: string, key: Buffer): string {
  if (!isEncryptedCredential(value))
    throw new Error(
      "Credencial armazenada sem cifragem; execute a recifragem antes de sincronizar.",
    );
  const parts = value.slice(CREDENTIAL_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Credencial cifrada em formato inválido.");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv!);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
  } catch {
    // Never echo ciphertext, key material or the decrypted value.
    throw new Error("Não foi possível decifrar a credencial (chave errada ou dado adulterado).");
  }
}

export function keyHint(appKey: string): string {
  const tail = appKey.replace(/[^A-Za-z0-9]/g, "").slice(-4);
  return "••••" + (tail || "0000");
}

export function encryptOmieCredentials(
  company: string,
  appKey: string,
  appSecret: string,
  key: Buffer = credentialsKey(),
) {
  return {
    appKeyEnc: encryptCredential(appKey, credentialAad(company, "omie", "app_key"), key),
    appSecretEnc: encryptCredential(appSecret, credentialAad(company, "omie", "app_secret"), key),
    hint: keyHint(appKey),
  };
}

/** Service-role only. Decrypted values never leave the calling module or reach logs. */
export async function loadOmieCredentials(
  admin: SupabaseClient<Database>,
  company: string,
  key?: Buffer,
): Promise<OmieCredentials> {
  const { data, error } = await admin.rpc("get_integration_credentials", {
    p_company: company,
    p_provider: "omie",
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row)
    throw new OmieError("auth", "Credenciais Omie não configuradas para esta empresa.", false);
  const secretKey = key ?? credentialsKey();
  return {
    appKey: decryptCredential(row.app_key, credentialAad(company, "omie", "app_key"), secretKey),
    appSecret: decryptCredential(
      row.app_secret,
      credentialAad(company, "omie", "app_secret"),
      secretKey,
    ),
  };
}
