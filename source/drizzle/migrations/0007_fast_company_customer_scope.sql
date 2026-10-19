create or replace function public.accessible_company_ids(_user_id uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when public.has_role(_user_id, 'SUPER_ADMIN')
    then (select coalesce(array_agg(id), '{}') from public.companies)
    else (select coalesce(array_agg(company_id), '{}') from public.user_company_access where user_id = _user_id) end
$$;

create or replace function public.visible_customer_ids(_user_id uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  with s as (select unnest(public.visible_seller_ids(_user_id)) id)
  select coalesce(array_agg(distinct c), '{}') from (
    select customer_id c from public.invoices where seller_id in (select id from s)
    union select customer_id from public.sales_orders where seller_id in (select id from s)) x
  where c is not null
$$;

do $$
declare p record; q text;
begin
  for p in select schemaname, tablename, policyname, qual from pg_policies
           where schemaname = 'public' and qual like '%can_access_company(auth.uid(), company_id)%' loop
    q := replace(p.qual, 'can_access_company(auth.uid(), company_id)',
      '((SELECT public.accessible_company_ids(auth.uid())) @> ARRAY[company_id])');
    execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, q);
  end loop;
end $$;

alter policy "customers scoped" on public.customers using (
  ((SELECT public.accessible_company_ids(auth.uid())) @> ARRAY[company_id])
  and ((NOT (SELECT public.is_seller_restricted(auth.uid())))
       or (SELECT public.visible_customer_ids(auth.uid())) @> ARRAY[id]));