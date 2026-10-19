/**
 * Omie credential operations (run inside the worker container; never prints values):
 *   node .output/credentials-ctl.mjs status
 *   node .output/credentials-ctl.mjs encrypt-existing
 *   node .output/credentials-ctl.mjs test <company-slug|all>
 */
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import {
  credentialAad,
  credentialsKey,
  encryptCredential,
  isEncryptedCredential,
} from "../src/lib/omie/credentials.server";
import { testOmieConnection } from "../src/lib/omie/sync.server";

const db = supabaseAdmin as unknown as {
  rpc: (
    f: string,
    a?: unknown,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function realCompanies(selector = "all") {
  const query = db.from("companies").select("id,slug").eq("is_demo", false).order("slug");
  const { data, error } = selector === "all" ? await query : await query.eq("slug", selector);
  if (error || !data?.length) throw new Error(`Empresa não encontrada: ${selector}`);
  return data as { id: string; slug: string }[];
}

async function stored(company: string) {
  const { data, error } = await db.rpc("get_integration_credentials", {
    p_company: company,
    p_provider: "omie",
  });
  if (error) throw new Error("Falha ao ler as credenciais.");
  return (Array.isArray(data) ? data[0] : null) as { app_key: string; app_secret: string } | null;
}

async function main([command, selector]: string[]) {
  if (command === "status") {
    const rows = [];
    for (const company of await realCompanies()) {
      const row = await stored(company.id);
      const { data: integration } = await db
        .from("company_integrations")
        .select("status,last_test_ok,last_test_at")
        .eq("company_id", company.id)
        .eq("provider", "omie")
        .maybeSingle();
      rows.push({
        company: company.slug,
        configured: Boolean(row),
        encrypted: row
          ? isEncryptedCredential(row.app_key) && isEncryptedCredential(row.app_secret)
          : null,
        status: integration?.status ?? null,
        lastTestOk: integration?.last_test_ok ?? null,
        lastTestAt: integration?.last_test_at ?? null,
      });
    }
    return out(rows);
  }
  if (command === "encrypt-existing") {
    const key = credentialsKey();
    const result = [];
    for (const company of await realCompanies()) {
      const row = await stored(company.id);
      if (!row) {
        result.push({ company: company.slug, action: "none" });
        continue;
      }
      if (isEncryptedCredential(row.app_key) && isEncryptedCredential(row.app_secret)) {
        result.push({ company: company.slug, action: "already_encrypted" });
        continue;
      }
      const appKey = isEncryptedCredential(row.app_key)
        ? null
        : encryptCredential(row.app_key, credentialAad(company.id, "omie", "app_key"), key);
      const appSecret = isEncryptedCredential(row.app_secret)
        ? null
        : encryptCredential(row.app_secret, credentialAad(company.id, "omie", "app_secret"), key);
      if (!appKey || !appSecret)
        throw new Error(`Estado misto em ${company.slug}; revisar manualmente.`);
      const { data, error } = await db.rpc("replace_integration_credentials_ciphertext", {
        p_company: company.id,
        p_provider: "omie",
        p_app_key_enc: appKey,
        p_app_secret_enc: appSecret,
      });
      if (error || data !== true) throw new Error(`Falha ao recifrar ${company.slug}.`);
      result.push({ company: company.slug, action: "encrypted" });
    }
    return out(result);
  }
  if (command === "test") {
    const result = [];
    for (const company of await realCompanies(selector ?? "all")) {
      const test = await testOmieConnection(supabaseAdmin, company.id);
      result.push({
        company: company.slug,
        status: test.status,
        ok: test.ok,
        message: test.message,
      });
    }
    return out(result);
  }
  throw new Error("Uso: status | encrypt-existing | test <empresa|all>");
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "falha");
  process.exitCode = 1;
});
