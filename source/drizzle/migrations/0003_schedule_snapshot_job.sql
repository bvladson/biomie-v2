create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.job_secrets (name text primary key, token text not null);
insert into private.job_secrets (name, token) values ('scheduler', encode(gen_random_bytes(32), 'hex')) on conflict (name) do nothing;

create or replace function public.verify_job_token(p_token text)
returns boolean language sql stable security definer set search_path = private, public as $$
  select exists (select 1 from private.job_secrets where name = 'scheduler' and token = p_token)
$$;
revoke all on function public.verify_job_token(text) from public, anon, authenticated;
grant execute on function public.verify_job_token(text) to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'biomie-flight-plan-snapshots';
select cron.schedule('biomie-flight-plan-snapshots', '15 8 * * *', $cmd$
  select net.http_post(
    url := 'https://project--a4f3277c-af7a-4b02-a910-0117996cd6d9-dev.lovable.app/api/public/jobs/flight-plan-snapshots',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select token from private.job_secrets where name = 'scheduler')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$cmd$);