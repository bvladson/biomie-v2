// Shared setup for the local PGlite checks: roles, auth stub, compat script and every migration of a release.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const AUTH_STUB = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin login noinherit; end if;
end $$;
create schema if not exists auth authorization supabase_auth_admin;
create table auth.users (instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz, confirmation_token varchar(255),
  confirmation_sent_at timestamptz, recovery_token varchar(255), recovery_sent_at timestamptz, email_change_token_new varchar(255),
  email_change varchar(255), email_change_sent_at timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb,
  raw_user_meta_data jsonb, is_super_admin boolean, created_at timestamptz, updated_at timestamptz, phone text,
  phone_confirmed_at timestamptz, phone_change text default '', phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz, confirmed_at timestamptz, email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0, banned_until timestamptz, reauthentication_token varchar(255) default '',
  reauthentication_sent_at timestamptz, is_sso_user boolean not null default false, deleted_at timestamptz,
  is_anonymous boolean not null default false);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz, updated_at timestamptz, factor_id uuid, aal text, not_after timestamptz, refreshed_at timestamp,
  user_agent text, ip inet, tag text);
alter table auth.users owner to supabase_auth_admin;
alter table auth.sessions owner to supabase_auth_admin;
`;

// The VPS renderer's psql script, flattened for a fresh database (every migration is "not applied yet").
// `exclude` drops whole migrations by tag, e.g. to rebuild the production state without a new one.
export function migrationsSql(src, exclude = []) {
  const rendered = execFileSync('python', [path.join(src, 'scripts/render-vps-migrations.py')], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = [];
  let skip = false;
  let dropping = false;
  for (const line of rendered.split(/\r?\n/)) {
    const tag = /^-- (\d{4}_[a-z0-9_]+); rendered SHA256/.exec(line);
    if (tag) dropping = exclude.includes(tag[1]);
    if (line.startsWith('select pg_advisory_unlock')) dropping = false;
    if (dropping) continue;
    if (line.startsWith('\\set ') || line.endsWith('\\gset')) continue;
    if (line.startsWith('\\if ')) { skip = true; continue; }
    if (line.startsWith('\\else')) { skip = false; continue; }
    if (line.startsWith('\\endif')) continue;
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

export async function setup(db, src, exclude = []) {
  const t0 = Date.now();
  await db.exec('create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions;');
  await db.exec(AUTH_STUB);
  await db.exec(readFileSync(path.join(src, 'deploy/db/00_supabase_compat.sql'), 'utf8'));
  await db.exec(migrationsSql(src, exclude));
  const applied = (await db.query('select count(*)::int n from private.vps_schema_migrations')).rows[0].n;
  console.log(`migrations applied: ${applied} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return applied;
}
