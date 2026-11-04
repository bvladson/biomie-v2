-- Desfaz a 0050_flight_plan_v2. NÃO é o retorno normal: a 0050 só acrescenta, e a release anterior
-- ignora tudo o que ela cria (reativar a release anterior basta). Use só se for preciso remover os
-- objetos novos. APAGA iniciativas, estados de alerta, decisões e o histórico de etapa dos pedidos;
-- metas da empresa (linhas sem vendedor) ficam na tabela e a release anterior não as lê.
-- Rodar com psql -1 (uma transação).

drop trigger if exists zz_track_sales_order_stage on public.sales_orders;
drop function if exists private.track_sales_order_stage();
drop table if exists private.sales_order_stage_events;

drop function if exists public.flight_plan_v2_me();
drop function if exists public.flight_plan_v2_dataset(uuid, int, int, jsonb, text, uuid, date, uuid, uuid, text, text, text);
drop function if exists public.flight_plan_v2_year(uuid, int, text, uuid, uuid, uuid, text, text, text);
drop function if exists public.flight_plan_v2_target_lists(uuid, text, uuid, int, uuid, uuid, text, text, text);
drop function if exists public.flight_plan_targets_month(uuid, int, int);
drop function if exists public.flight_plan_save_targets(uuid, int, int, jsonb);
drop function if exists public.flight_plan_set_commit(uuid, uuid, int, int, numeric, text);
drop function if exists public.flight_plan_save_initiative(jsonb);
drop function if exists public.flight_plan_set_initiative_status(uuid, text, numeric, text);
drop function if exists public.flight_plan_set_alert_state(jsonb);
drop function if exists public.flight_plan_sync_alerts(uuid, int, int, text[], jsonb);
drop function if exists public.flight_plan_add_decision(uuid, date, text);
drop function if exists public.flight_plan_history(uuid, text, int);
drop schema if exists flight_plan_internal cascade;

drop table if exists public.flight_plan_alert_states;
drop table if exists public.flight_plan_decisions;
drop table if exists public.flight_plan_initiatives;
drop index if exists public.audit_log_entity_lookup;

drop index if exists public.sales_targets_one_active;
drop index if exists public.sales_targets_one_company;
alter table public.sales_targets drop constraint if exists sales_targets_values_check;
alter table public.sales_targets drop column if exists updated_by, drop column if exists updated_at;

-- Canal do vendedor volta a ficar vazio nas empresas reais (como antes da 0050).
drop trigger if exists zz_sellers_official_channel on public.sellers;
drop function if exists public.apply_seller_official_channel();
update public.sellers s set channel_id = null
  where exists (select 1 from public.companies c where c.id = s.company_id and not c.is_demo);
drop function if exists public.seller_official_channel(uuid, text, text);

update public.metric_config
  set config = config - 'saturdayWeights' - 'saturdayWeightDefault' - 'lateOrderWeight' - 'alerts' - 'conversion' - 'targetLists',
      version = version + 1, updated_at = now()
  where metric_key = 'flight_plan';

delete from private.vps_schema_migrations where name = '0050_flight_plan_v2';
notify pgrst, 'reload schema';
