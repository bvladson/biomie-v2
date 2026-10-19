create or replace function public.visible_seller_ids(_user_id uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct s.id), '{}') from public.sellers s
  where s.user_id = _user_id
     or (public.has_role(_user_id, 'GESTOR') and exists (
          select 1 from public.sales_team_members m
          join public.sales_team_managers g on g.team_id = m.team_id and g.valid_to is null
          join public.sales_teams t on t.id = m.team_id and t.active
          where m.seller_id = s.id and m.valid_to is null and g.user_id = _user_id))
$$;

-- Read policies: evaluate the user's seller scope once per statement instead of per row.
-- Write checks (single row) keep can_view_seller.
do $$
declare p record; q text;
  r constant text := '((NOT (SELECT public.is_seller_restricted(auth.uid()))) OR (SELECT public.visible_seller_ids(auth.uid())) @> ARRAY[\1])';
begin
  for p in select schemaname, tablename, policyname, qual from pg_policies
           where schemaname = 'public' and qual ilike '%can_view_seller%' loop
    q := regexp_replace(p.qual, 'can_view_seller\(auth\.uid\(\), ([a-z_\.]+)\)', r, 'g');
    q := replace(q, '(NOT is_seller_restricted(auth.uid()))', '(NOT (SELECT public.is_seller_restricted(auth.uid())))');
    execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, q);
  end loop;
end $$;