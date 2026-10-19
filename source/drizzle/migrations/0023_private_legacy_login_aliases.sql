-- Username compatibility stays server-side; no public directory of Auth emails.
create table private.legacy_user_aliases (
  alias text primary key check (alias=lower(trim(alias)) and length(alias) between 1 and 320),
  user_id uuid not null references auth.users(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index legacy_user_aliases_user_idx on private.legacy_user_aliases(user_id);
revoke all on private.legacy_user_aliases from public,anon,authenticated,service_role;

create or replace function public.resolve_legacy_login(p_identifier text)
returns text language plpgsql stable security definer set search_path = private, public, auth as $$
declare v_email text;
begin
  if not public.is_service_request() then raise exception 'Server only' using errcode='42501'; end if;
  select u.email into v_email from private.legacy_user_aliases a join auth.users u on u.id=a.user_id
    where a.alias=lower(trim(p_identifier)) and a.is_active and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now());
  return v_email;
end $$;
revoke all on function public.resolve_legacy_login(text) from public,anon,authenticated;
grant execute on function public.resolve_legacy_login(text) to service_role;
notify pgrst, 'reload schema';
