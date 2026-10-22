-- 0042: Estoque — "leitura parada" passa a contar do último avanço, e não do início.
--
-- Sonda em produção (22/10/2026): o Omie devolve no máximo 50 posições por página em
-- ListarPosEstoque (mesmo pedindo 100) e calcula o total de páginas com 50. A MAG Filial tem
-- 11.088 posições (7 locais) = 222 páginas; com 2 s entre chamadas do mesmo método e 15 s de
-- estoque por ciclo do worker, a leitura pode passar de 30 minutos. Contado do início, o limite
-- de 30 minutos a recomeçaria do zero sem fim (e seguraria a fila das outras empresas).
--
-- Agora a leitura recomeça quando:
--   - fica 30 minutos sem gravar página (worker parado, bloqueio 425 do Omie); ou
--   - passa de 3 horas desde o início (nunca juntar páginas de horários muito diferentes).
-- Só acréscimos: uma coluna nova e as mesmas funções, com as mesmas assinaturas e permissões.

alter table private.stock_readings add column if not exists progress_at timestamptz;

-- Recomeça do zero, guardando o motivo (estoque mudou no meio, página repetida, parada longa).
create or replace function stock_internal.restart(p_reading uuid, p_reason text, p_delay interval)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from private.stock_positions where reading_id = p_reading;
  update private.stock_readings set status = 'queued', pages_done = 0, pages_total = null,
      records_expected = null, records_received = 0, locations = null, started_at = null, progress_at = null,
      next_attempt_at = now() + p_delay, error = p_reason
    where id = p_reading;
end $$;

-- Próxima leitura para o worker (continua a que está em andamento).
create or replace function public.stock_worker_claim() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_reading private.stock_readings;
  v_stale record;
begin
  -- Sem avanço há 30 min (processo parado, bloqueio longo) ou iniciada há mais de 3 h: recomeça
  -- do zero, para nunca juntar páginas de horários muito diferentes.
  for v_stale in
    select r.id, r.started_at < now() - interval '3 hours' as too_long
    from private.stock_readings r
    where r.status in ('queued', 'running') and r.started_at is not null
      and (coalesce(r.progress_at, r.started_at) < now() - interval '30 minutes'
           or r.started_at < now() - interval '3 hours')
    for update skip locked
  loop
    perform stock_internal.restart(v_stale.id,
      case when v_stale.too_long then 'Leitura passou de 3 horas; recomeçando.'
           else 'Leitura parada por mais de 30 minutos; recomeçando.' end,
      interval '0 seconds');
  end loop;
  select * into v_reading from private.stock_readings r
    where r.status in ('queued', 'running') and (r.next_attempt_at is null or r.next_attempt_at <= now())
    order by (r.status = 'running') desc, (r.kind = 'close') desc, r.created_at
    limit 1 for update skip locked;
  if not found then return null; end if;
  if v_reading.pages_done = 0 and v_reading.attempts >= 4 then
    update private.stock_readings set status = 'failed', finished_at = now(), next_attempt_at = null,
        error = coalesce(error, 'Leitura abandonada após 4 tentativas.')
      where id = v_reading.id;
    return null;
  end if;
  update private.stock_readings set status = 'running', started_at = coalesce(started_at, now()),
      progress_at = coalesce(progress_at, now()),
      attempts = attempts + case when pages_done = 0 then 1 else 0 end, next_attempt_at = null
    where id = v_reading.id returning * into v_reading;
  return jsonb_build_object('id', v_reading.id, 'companyId', v_reading.company_id,
    'positionDate', to_char(v_reading.position_date, 'DD/MM/YYYY'), 'nextPage', v_reading.pages_done + 1,
    'pagesTotal', v_reading.pages_total, 'recordsExpected', v_reading.records_expected,
    'locationsLoaded', v_reading.locations is not null, 'kind', v_reading.kind, 'attempts', v_reading.attempts);
end $$;

create or replace function public.stock_worker_save_locations(p_reading uuid, p_locations jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if jsonb_typeof(coalesce(p_locations, '{}'::jsonb)) <> 'object' then raise exception 'locais inválidos'; end if;
  update private.stock_readings set locations = coalesce(p_locations, '{}'::jsonb), progress_at = clock_timestamp()
    where id = p_reading and status = 'running';
  if not found then raise exception 'leitura não está em andamento'; end if;
end $$;

create or replace function public.stock_worker_save_page(p_reading uuid, p_page integer, p_pages_total integer,
  p_records_total integer, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_reading private.stock_readings;
  v_saved integer;
begin
  select * into v_reading from private.stock_readings where id = p_reading for update;
  if not found or v_reading.status <> 'running' then raise exception 'leitura não está em andamento'; end if;
  if p_page is null or p_page <> v_reading.pages_done + 1 then
    raise exception 'página fora de ordem (recebida %, esperada %)', p_page, v_reading.pages_done + 1;
  end if;
  if p_pages_total is null or p_pages_total < 1 or p_records_total is null or p_records_total < 0
     or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'página inválida';
  end if;
  if (v_reading.pages_total is not null and v_reading.pages_total <> p_pages_total)
     or (v_reading.records_expected is not null and v_reading.records_expected <> p_records_total) then
    perform stock_internal.restart(p_reading, 'O total de posições mudou durante a leitura; recomeçando.',
      interval '2 minutes');
    return jsonb_build_object('restarted', true, 'done', false);
  end if;
  begin
    insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
        physical_qty, balance_qty, reserved_qty, pending_qty, min_qty, unit_cost, sale_price)
      select v_reading.id, v_reading.company_id, x.omie_product_id, x.location_code, x.sku, x.name,
        x.physical_qty, x.balance_qty, coalesce(x.reserved_qty, 0), coalesce(x.pending_qty, 0), x.min_qty,
        x.unit_cost, coalesce(x.sale_price, 0)
      from jsonb_to_recordset(p_rows) as x(omie_product_id text, location_code text, sku text, name text,
        physical_qty numeric, balance_qty numeric, reserved_qty numeric, pending_qty numeric,
        min_qty numeric, unit_cost numeric, sale_price numeric);
    get diagnostics v_saved = row_count;
  exception when unique_violation then
    perform stock_internal.restart(p_reading, 'O Omie devolveu a mesma posição duas vezes; recomeçando.',
      interval '2 minutes');
    return jsonb_build_object('restarted', true, 'done', false);
  end;
  update private.stock_readings set pages_done = p_page, pages_total = p_pages_total,
      records_expected = p_records_total, records_received = records_received + v_saved,
      progress_at = clock_timestamp()
    where id = p_reading;
  return jsonb_build_object('restarted', false, 'saved', v_saved, 'done', p_page >= p_pages_total);
end $$;

-- As mesmas permissões da 0041 (create or replace já as preserva; aqui ficam explícitas).
revoke all on function stock_internal.restart(uuid, text, interval) from public, anon, authenticated;
revoke all on function public.stock_worker_claim(), public.stock_worker_save_locations(uuid, jsonb),
  public.stock_worker_save_page(uuid, integer, integer, integer, jsonb)
from public, anon, authenticated;
grant execute on function public.stock_worker_claim(), public.stock_worker_save_locations(uuid, jsonb),
  public.stock_worker_save_page(uuid, integer, integer, integer, jsonb)
to service_role;

notify pgrst, 'reload schema';
