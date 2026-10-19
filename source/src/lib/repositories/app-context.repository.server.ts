import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AppRole } from "@/domain/rbac";

export interface AppContextDTO {
  user: { id: string; email: string | null; fullName: string | null };
  roles: AppRole[];
  companies: { id: string; name: string; isDemo: boolean; dataAsOf: string }[];
  defaultCompanyId: string | null;
}

export async function loadAppContext(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<AppContextDTO> {
  const readProfile = () => supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  let profileResult = await readProfile();
  if (profileResult.error) throw new Error("Não foi possível carregar seu perfil.");

  if (!profileResult.data) {
    const { error } = await supabase.rpc("ensure_app_profile");
    if (error) throw new Error("Não foi possível provisionar sua conta.");
    profileResult = await readProfile();
    if (profileResult.error || !profileResult.data)
      throw new Error("Não foi possível carregar seu perfil.");
  }
  const profile = profileResult.data;

  const [roles, companies] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", userId),
    supabase.from("companies").select("id,name,is_demo").order("name"),
  ]);
  if (roles.error || companies.error)
    throw new Error("Não foi possível carregar suas permissões e empresas.");

  const companyRows = companies.data ?? [];
  const asOf = await Promise.all(
    companyRows.map(async (company) => {
      const { data, error } = await supabase.rpc("data_as_of", { p_company: company.id });
      if (error || typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data))
        throw new Error("Não foi possível carregar a data de referência da empresa.");
      return data;
    }),
  );

  return {
    user: { id: userId, email: profile.email, fullName: profile.full_name },
    roles: (roles.data ?? []).map((row) => row.role as AppRole),
    companies: companyRows.map((company, index) => ({
      id: company.id,
      name: company.name,
      isDemo: company.is_demo,
      dataAsOf: asOf[index]!,
    })),
    defaultCompanyId: profile.default_company_id,
  };
}
