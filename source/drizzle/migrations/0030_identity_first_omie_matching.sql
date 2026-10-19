-- Match the stable provider identity before optional legacy heuristics.
-- Fallback keys are grouped once per company, avoiding an O(n^2) document scan.
alter table public.canonical_entity_matches drop constraint if exists canonical_entity_matches_method_check;
alter table public.canonical_entity_matches add constraint canonical_entity_matches_method_check
  check(method in ('external_id','name','email','document','sku','manual','none'));

create or replace function public.compute_omie_matches(p_company uuid,p_entity text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare canonical_table text; target_table text; canonical_key text; target_key text; fallback_method text;
begin
  perform public.integration_admin_assert(p_company);
  if p_entity='vendors' then
    canonical_table:='canonical_vendors'; target_table:='sellers';
    canonical_key:='public.normalize_text(c.name)'; target_key:='public.normalize_text(t.name)'; fallback_method:='name';
  elsif p_entity='customers' then
    canonical_table:='canonical_customers'; target_table:='customers';
    canonical_key:='c.document_hash'; target_key:='public.document_hash(t.document)'; fallback_method:='document';
  elsif p_entity='products' then
    canonical_table:='canonical_products'; target_table:='products';
    canonical_key:='nullif(lower(trim(c.sku)),'''')'; target_key:='nullif(lower(trim(t.sku)),'''')'; fallback_method:='sku';
  else
    raise exception 'Entidade inválida';
  end if;
  execute format($q$
    with fallback_keys as materialized (
      select t.id,%s match_key from public.%I t where t.company_id=$1
    ), fallback_candidates as materialized (
      select match_key,array_agg(id order by id) candidates
      from fallback_keys where match_key is not null group by match_key
    ), candidates as (
      select c.id,
        case when target.id is not null then array[target.id] else f.candidates end candidate_ids,
        case when target.id is not null then 'external_id' else $3 end matched_by
      from public.%I c
      left join public.%I target on target.company_id=c.company_id
        and target.source='omie' and target.external_id=c.external_id
      left join fallback_candidates f on target.id is null and f.match_key=%s
      where c.company_id=$1
    )
    insert into public.canonical_entity_matches(company_id,entity,canonical_id,biomie_id,method,status,candidates,updated_at)
    select $1,$2,c.id,
      case when cardinality(c.candidate_ids)=1 then c.candidate_ids[1] end,
      case when coalesce(cardinality(c.candidate_ids),0)=0 then 'none' else c.matched_by end,
      case when coalesce(cardinality(c.candidate_ids),0)=0 then 'UNMATCHED'
        when cardinality(c.candidate_ids)=1 then 'MATCHED' else 'CONFLICT' end,
      coalesce(cardinality(c.candidate_ids),0),now()
    from candidates c
    on conflict(entity,canonical_id) do update set
      biomie_id=excluded.biomie_id,method=excluded.method,status=excluded.status,
      candidates=excluded.candidates,updated_at=now()
    where canonical_entity_matches.company_id=$1 and canonical_entity_matches.status not in ('MANUAL','IGNORED')
  $q$,target_key,target_table,canonical_table,target_table,canonical_key)
  using p_company,p_entity,fallback_method;
  return (select jsonb_object_agg(status,n) from
    (select status,count(*) n from public.canonical_entity_matches
      where company_id=p_company and entity=p_entity group by status) results);
end $$;
revoke all on function public.compute_omie_matches(uuid,text) from public,anon;
grant execute on function public.compute_omie_matches(uuid,text) to authenticated,service_role;
