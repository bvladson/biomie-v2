"""Render a psql deployment script without editing the delivered migrations.

Usage: python3 scripts/render-vps-migrations.py > /tmp/biomie-migrations.sql
Then: psql -v ON_ERROR_STOP=1 -f /tmp/biomie-migrations.sql
Requires GoTrue to have initialized auth.users and 00_supabase_compat.sql.
"""
from pathlib import Path
import hashlib
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

root = Path(__file__).resolve().parents[1]
migrations = root / "drizzle" / "migrations"
entries = json.loads((migrations / "meta" / "_journal.json").read_text(encoding="utf-8"))["entries"]
print(r"\set ON_ERROR_STOP on")
print("set search_path = public, extensions;")
print("do $$ begin if to_regclass('auth.users') is null then raise exception 'Start GoTrue and wait for auth.users before app migrations'; end if; end $$;")
print("create schema if not exists private;")
print("revoke all on schema private from public, anon, authenticated;")
print("create table if not exists private.vps_schema_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now());")
print("select pg_advisory_lock(hashtextextended('biomie.vps.migrations',0));")
for entry in entries:
    name = entry["tag"]
    original = (migrations / (name + ".sql")).read_text(encoding="utf-8")
    sql = original
    if name == "0003_schedule_snapshot_job":
        sql = """-- VPS uses the external worker, without pg_cron/pg_net or preview URL.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.job_secrets (name text primary key, token text not null);
insert into private.job_secrets(name,token) values('scheduler',encode(extensions.gen_random_bytes(32),'hex')) on conflict(name) do nothing;
create or replace function public.verify_job_token(p_token text)
returns boolean language sql stable security definer set search_path=private,public as $$
select exists(select 1 from private.job_secrets where name='scheduler' and token=p_token)
$$;
revoke all on function public.verify_job_token(text) from public,anon,authenticated;
grant execute on function public.verify_job_token(text) to service_role;
"""
    digest = hashlib.sha256(sql.encode("utf-8")).hexdigest()
    print(f"-- {name}; rendered SHA256 {digest}")
    print(f"select exists(select 1 from private.vps_schema_migrations where name='{name}') as already_applied \\gset")
    print(r"\if :already_applied")
    print(f"do $$ begin if not exists(select 1 from private.vps_schema_migrations where name='{name}' and sha256='{digest}') then raise exception 'Migration checksum mismatch: {name}'; end if; end $$;")
    print(r"\else")
    print("begin;")
    print(sql)
    print(f"insert into private.vps_schema_migrations(name,sha256) values('{name}','{digest}');")
    print("commit;")
    print(r"\endif")
print("select pg_advisory_unlock(hashtextextended('biomie.vps.migrations',0));")
print("notify pgrst, 'reload schema';")
