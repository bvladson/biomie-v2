-- The transactional pipeline writes runs with mode PERIOD/BACKFILL and entities
-- receivables/settlements, but 0012 only allowed FULL/INCREMENTAL and a generic
-- "financial" entity, so no transactional load could ever start (found in the
-- first real production pilot on 19/10/2026).
alter table public.integration_sync_runs drop constraint if exists integration_sync_runs_mode_check;
alter table public.integration_sync_runs add constraint integration_sync_runs_mode_check
  check (mode in ('FULL','INCREMENTAL','PERIOD','BACKFILL'));
alter table public.integration_sync_runs drop constraint if exists integration_sync_runs_entity_check;
alter table public.integration_sync_runs add constraint integration_sync_runs_entity_check
  check (entity in ('vendors','customers','products','invoices','orders','receivables','settlements','financial'));
notify pgrst, 'reload schema';
