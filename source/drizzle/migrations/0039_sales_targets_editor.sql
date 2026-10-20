-- Targets editor (first post go-live evolution, 20/10/2026).
-- Managers and admins fill a month for the whole team in one grid.
-- * Reads: sales_targets_grid returns only the sellers the caller can see
--   (same rule as the "targets scoped" policy) and says which rows are editable.
-- * Writes: only through save_sales_targets. It runs as owner (SECURITY DEFINER,
--   pinned search_path, EXECUTE only for authenticated) and validates the scope of
--   auth.uid() on every row: ADMIN/SUPER_ADMIN of the company, or the GESTOR who
--   manages the seller's team today. One call is one transaction: any row outside
--   the caller's scope rejects the whole save. Direct INSERT/UPDATE/DELETE on
--   sales_targets stay denied to signed-in users (they only have SELECT).

alter table public.sales_targets
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

-- One active value per seller, month and level (the read models sum by seller).
create unique index if not exists sales_targets_one_active
  on public.sales_targets (company_id, seller_id, year, month, level)
  where active and seller_id is not null;

alter table public.sales_targets drop constraint if exists sales_targets_values_check;
alter table public.sales_targets add constraint sales_targets_values_check
  check (amount >= 0 and month between 1 and 12 and year between 2000 and 2100);

-- Internal helper: who may change a seller's target. Never callable by clients.
create or replace function public.can_manage_seller_target(_user_id uuid, _company uuid, _seller uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select _user_id is not null
    and public.can_access_company(_user_id, _company)
    and exists (select 1 from public.sellers s where s.id = _seller and s.company_id = _company)
    and (public.has_role(_user_id, 'SUPER_ADMIN') or public.has_role(_user_id, 'ADMIN')
         or public.manages_seller(_user_id, _seller))
$$;
revoke all on function public.can_manage_seller_target(uuid, uuid, uuid) from public, anon, authenticated;

-- The month grid for one company: sellers the caller can see (active ones, plus
-- any seller that already has a target in the month or the previous month), the
-- three levels of the month, the previous month for reference, and editability.
create or replace function public.sales_targets_grid(p_company uuid, p_year int, p_month int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_prev date; v jsonb;
begin
  if v_uid is null then raise exception 'Sessão expirada.' using errcode = '42501'; end if;
  if p_month is null or p_year is null or p_month not between 1 and 12 or p_year not between 2000 and 2100 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if not public.can_access_company(v_uid, p_company) then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  v_prev := (make_date(p_year, p_month, 1) - interval '1 month')::date;
  with s as (
    select s.id, s.name, coalesce(s.active, true) is_active,
      (select t.name from public.sales_team_members m join public.sales_teams t on t.id = m.team_id
        where m.seller_id = s.id and m.valid_to is null and t.active order by t.name limit 1) team,
      public.can_manage_seller_target(v_uid, p_company, s.id) editable
    from public.sellers s
    where s.company_id = p_company and public.can_view_seller(v_uid, s.id)
  ), cur as (
    select seller_id, jsonb_object_agg(level::text, amount) v from public.sales_targets
    where company_id = p_company and year = p_year and month = p_month and active and seller_id is not null
    group by 1
  ), prev as (
    select seller_id, jsonb_object_agg(level::text, amount) v from public.sales_targets
    where company_id = p_company and year = extract(year from v_prev)::int and month = extract(month from v_prev)::int
      and active and seller_id is not null
    group by 1
  )
  select jsonb_build_object(
    'company', p_company, 'year', p_year, 'month', p_month,
    'activeLevel', public.active_target_level(),
    'canEdit', coalesce(bool_or(s.editable), false),
    'sellers', coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'team', s.team, 'active', s.is_active, 'editable', s.editable,
        'targets', coalesce(cur.v, '{}'::jsonb), 'previous', coalesce(prev.v, '{}'::jsonb))
      order by s.is_active desc, s.name), '[]'::jsonb))
  into v
  from s left join cur on cur.seller_id = s.id left join prev on prev.seller_id = s.id
  where s.is_active or cur.v is not null or prev.v is not null;
  return v;
end $$;
revoke all on function public.sales_targets_grid(uuid, int, int) from public, anon;
grant execute on function public.sales_targets_grid(uuid, int, int) to authenticated;

-- Saves a batch of cells: [{"seller": uuid, "level": "BASE|ACTIVE|CHALLENGE", "amount": number|null}].
-- null clears the cell. Unchanged values are skipped. Audited in audit_log.
create or replace function public.save_sales_targets(p_company uuid, p_year int, p_month int, p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); r jsonb; v_seller uuid; v_level public.target_level; v_amount numeric;
  v_old numeric; v_channel uuid; n_saved int := 0; n_deleted int := 0; n_same int := 0;
  v_changes jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'Sessão expirada.' using errcode = '42501'; end if;
  if p_month is null or p_year is null or p_month not between 1 and 12 or p_year not between 2000 and 2100 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if not public.can_access_company(v_uid, p_company) then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Nenhuma meta enviada.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 3000 then
    raise exception 'Envio grande demais: salve em partes.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' or coalesce(r->>'seller', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(r->>'level', '') not in ('BASE', 'ACTIVE', 'CHALLENGE') then
      raise exception 'Linha de meta inválida.' using errcode = '22023';
    end if;
    v_seller := (r->>'seller')::uuid;
    v_level := (r->>'level')::public.target_level;
    if not public.can_manage_seller_target(v_uid, p_company, v_seller) then
      raise exception 'Sem permissão para alterar a meta deste vendedor.' using errcode = '42501';
    end if;
    if r->'amount' is null or jsonb_typeof(r->'amount') = 'null' then
      v_amount := null;
    elsif jsonb_typeof(r->'amount') = 'number' then
      v_amount := round((r->>'amount')::numeric, 2);
    else
      raise exception 'Valor de meta inválido.' using errcode = '22023';
    end if;
    if v_amount is not null and (v_amount < 0 or v_amount > 999999999999.99) then
      raise exception 'Valor de meta fora do intervalo permitido.' using errcode = '22023';
    end if;
    select amount into v_old from public.sales_targets
      where company_id = p_company and seller_id = v_seller and year = p_year and month = p_month
        and level = v_level and active
      for update;
    if v_amount is null then
      if v_old is null then n_same := n_same + 1; continue; end if;
      delete from public.sales_targets
        where company_id = p_company and seller_id = v_seller and year = p_year and month = p_month
          and level = v_level and active;
      n_deleted := n_deleted + 1;
    elsif v_old is not distinct from v_amount then
      n_same := n_same + 1; continue;
    elsif v_old is null then
      select channel_id into v_channel from public.sellers where id = v_seller;
      insert into public.sales_targets(company_id, channel_id, seller_id, year, month, level, amount, active, updated_at, updated_by)
        values (p_company, v_channel, v_seller, p_year, p_month, v_level, v_amount, true, now(), v_uid);
      n_saved := n_saved + 1;
    else
      update public.sales_targets set amount = v_amount, updated_at = now(), updated_by = v_uid
        where company_id = p_company and seller_id = v_seller and year = p_year and month = p_month
          and level = v_level and active;
      n_saved := n_saved + 1;
    end if;
    if jsonb_array_length(v_changes) < 500 then
      v_changes := v_changes || jsonb_build_object('seller', v_seller, 'level', v_level, 'from', v_old, 'to', v_amount);
    end if;
  end loop;
  if n_saved + n_deleted > 0 then
    insert into public.audit_log(actor_id, action, entity, entity_id, payload)
    values (v_uid, 'sales_targets.saved', 'sales_targets', p_company::text,
            jsonb_build_object('year', p_year, 'month', p_month, 'saved', n_saved, 'deleted', n_deleted,
                               'changes', v_changes));
  end if;
  return jsonb_build_object('saved', n_saved, 'deleted', n_deleted, 'unchanged', n_same);
end $$;
revoke all on function public.save_sales_targets(uuid, int, int, jsonb) from public, anon;
grant execute on function public.save_sales_targets(uuid, int, int, jsonb) to authenticated;

notify pgrst, 'reload schema';
