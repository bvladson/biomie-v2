-- Keep validated imported entries; add new master-data IDs already synchronized
-- from Omie so future transactions do not depend on a frozen legacy directory.
create or replace function public.get_legacy_classification_config(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path=private,public as $$
declare result jsonb; vendors jsonb; customers jsonb;
begin
  if not public.is_service_request() then raise exception 'Server only' using errcode='42501'; end if;
  if not exists(select 1 from public.companies where id=p_company) then raise exception 'Company not found'; end if;
  select settings into result from private.legacy_classification_config where company_id=p_company;
  result:=coalesce(result,'{}'::jsonb);
  vendors:=case when jsonb_typeof(result->'vendors')='array' then result->'vendors' else '[]'::jsonb end;
  customers:=case when jsonb_typeof(result->'customers')='array' then result->'customers' else '[]'::jsonb end;
  select vendors||coalesce(jsonb_agg(jsonb_build_object('external_id',v.external_id,'name',v.name) order by v.external_id),'[]'::jsonb)
    into vendors from public.canonical_vendors v where v.company_id=p_company and v.source='omie'
      and not v.missing_in_source and not exists(select 1 from jsonb_array_elements(vendors) old where old->>'external_id'=v.external_id);
  select customers||coalesce(jsonb_agg(jsonb_build_object('external_id',c.external_id,'document_hash',c.document_hash) order by c.external_id),'[]'::jsonb)
    into customers from public.canonical_customers c where c.company_id=p_company and c.source='omie'
      and not c.missing_in_source and not exists(select 1 from jsonb_array_elements(customers) old where old->>'external_id'=c.external_id);
  return result||jsonb_build_object('vendors',vendors,'customers',customers);
end $$;
revoke all on function public.get_legacy_classification_config(uuid) from public,anon,authenticated;
grant execute on function public.get_legacy_classification_config(uuid) to service_role;
notify pgrst, 'reload schema';
