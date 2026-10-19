-- Run as the database owner BEFORE starting GoTrue/PostgREST.
-- Passwords are supplied separately by the deployment environment.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
revoke create on schema public from public;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role, supabase_auth_admin;
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase's database image supplies these functions; GoTrue alone does not.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''), auth.jwt()->>'sub')::uuid
$$;
create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role',true),''), auth.jwt()->>'role')
$$;
revoke all on function auth.jwt(),auth.uid(),auth.role() from public;
grant execute on function auth.jwt(),auth.uid(),auth.role() to anon,authenticated,service_role,supabase_auth_admin;
-- GoTrue migrations replace uid/role; their owner must be its migration role.
alter function auth.jwt() owner to supabase_auth_admin;
alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;

-- Auth owns its tables. App migrations must never manufacture auth.users.
alter role supabase_auth_admin set search_path = auth, public, extensions;
notify pgrst, 'reload schema';
