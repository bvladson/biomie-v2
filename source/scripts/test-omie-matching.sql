-- Run after 0030 with psql -v ON_ERROR_STOP=1 -f this-file. All writes roll back.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare
  co uuid:=gen_random_uuid(); other_co uuid:=gen_random_uuid();
  exact_id uuid:=gen_random_uuid(); foreign_id uuid:=gen_random_uuid();
  by_identity uuid:=gen_random_uuid(); by_document uuid:=gen_random_uuid();
  ambiguous uuid:=gen_random_uuid(); manual_id uuid:=gen_random_uuid(); ignored_id uuid:=gen_random_uuid();
  isolated uuid:=gen_random_uuid(); vendor_id uuid:=gen_random_uuid(); product_id uuid:=gen_random_uuid();
begin
  insert into public.companies(id,name,slug,is_demo,data_source) values
    (co,'Matching fixture','match-'||co,false,'OMIE_SHADOW'),
    (other_co,'Other matching fixture','match-'||other_co,false,'OMIE_SHADOW');
  insert into public.customers(id,company_id,name,state,city,source,external_id,document) values
    (exact_id,co,'Identity customer','CE','Fortaleza','omie','identity',null),
    (foreign_id,other_co,'Foreign identity','CE','Fortaleza','omie','foreign',null),
    (gen_random_uuid(),co,'Legacy one','CE','Fortaleza','demo',null,'12345678901'),
    (gen_random_uuid(),co,'Legacy conflict A','CE','Fortaleza','demo',null,'12345678902'),
    (gen_random_uuid(),co,'Legacy conflict B','CE','Fortaleza','demo',null,'12345678902');
  insert into public.canonical_customers(id,company_id,external_id,name,document_hash) values
    (by_identity,co,'identity','Identity customer',public.document_hash('99999999999')),
    (by_document,co,'legacy','Legacy customer',public.document_hash('12345678901')),
    (ambiguous,co,'conflict','Conflict customer',public.document_hash('12345678902')),
    (manual_id,co,'manual','Manual customer',null),
    (ignored_id,co,'ignored','Ignored customer',null),
    (isolated,co,'foreign','Isolated customer',null);
  insert into public.canonical_entity_matches(company_id,entity,canonical_id,biomie_id,method,status,candidates,note) values
    (co,'customers',manual_id,exact_id,'manual','MANUAL',1,'Preserve manual decision'),
    (co,'customers',ignored_id,null,'none','IGNORED',0,'Preserve ignored decision');
  perform public.compute_omie_matches(co,'customers');
  perform public.compute_omie_matches(co,'customers');
  if not exists(select 1 from public.canonical_entity_matches where canonical_id=by_identity and biomie_id=exact_id
    and method='external_id' and status='MATCHED' and candidates=1)
    then raise exception 'Stable identity did not match a Gold customer with no document'; end if;
  if not exists(select 1 from public.canonical_entity_matches where canonical_id=by_document
    and method='document' and status='MATCHED' and candidates=1)
    then raise exception 'Legacy document fallback failed'; end if;
  if not exists(select 1 from public.canonical_entity_matches where canonical_id=ambiguous
    and biomie_id is null and method='document' and status='CONFLICT' and candidates=2)
    then raise exception 'Ambiguous document fallback was accepted'; end if;
  if not exists(select 1 from public.canonical_entity_matches where canonical_id=isolated and status='UNMATCHED')
    then raise exception 'Provider identity crossed company boundary'; end if;
  if not exists(select 1 from public.canonical_entity_matches where canonical_id=manual_id
    and status='MANUAL' and biomie_id=exact_id and note='Preserve manual decision')
    or not exists(select 1 from public.canonical_entity_matches where canonical_id=ignored_id
    and status='IGNORED' and note='Preserve ignored decision')
    then raise exception 'Operator decisions were overwritten'; end if;
  if (select count(*) from public.canonical_entity_matches where company_id=co and entity='customers')<>6
    then raise exception 'Matching is not idempotent'; end if;
  insert into public.sellers(id,company_id,name,source,external_id) values(vendor_id,co,'Seller','omie','seller');
  insert into public.canonical_vendors(company_id,external_id,name) values(co,'seller','Different seller name');
  perform public.compute_omie_matches(co,'vendors');
  if not exists(select 1 from public.canonical_entity_matches where company_id=co and entity='vendors'
    and biomie_id=vendor_id and method='external_id' and status='MATCHED')
    then raise exception 'Vendor identity did not precede names'; end if;
  insert into public.products(id,company_id,name,category,base_price,source,external_id,sku)
    values(product_id,co,'Product','Fixture',0,'omie','product','different');
  insert into public.canonical_products(company_id,external_id,description,sku) values(co,'product','Product','source');
  perform public.compute_omie_matches(co,'products');
  if not exists(select 1 from public.canonical_entity_matches where company_id=co and entity='products'
    and biomie_id=product_id and method='external_id' and status='MATCHED')
    then raise exception 'Product identity did not precede SKU'; end if;
  raise notice 'Omie matching fixture passed (all writes roll back).';
end $$;
rollback;
