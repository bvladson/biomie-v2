-- Raw title reads expose both dates and original amounts. Users without overdue
-- access read only the capability-filtered SECURITY DEFINER RPC results.
drop policy "fin titles scoped" on public.financial_titles;
create policy "fin titles scoped" on public.financial_titles for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id]
    and (select public.has_finance_capability('finance.view_titles'))
    and (select public.has_finance_capability('finance.view_overdue'))
    and ((not (select public.is_seller_restricted(auth.uid())))
         or (select public.visible_seller_ids(auth.uid())) @> array[seller_id]));
notify pgrst, 'reload schema';
