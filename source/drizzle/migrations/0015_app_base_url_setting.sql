create table if not exists private.app_settings (key text primary key, value text not null, updated_at timestamptz not null default now());

create or replace function public.set_app_base_url(p_url text)
returns void language plpgsql security definer set search_path = private, public as $$
begin
  if not (public.is_service_request() or public.has_role(auth.uid(), 'SUPER_ADMIN')) then
    raise exception 'Somente Super Admin.' using errcode = '42501';
  end if;
  if p_url !~ '^https://[a-z0-9.-]+(:[0-9]+)?$' then raise exception 'URL inválida (use https://dominio, sem barra final).'; end if;
  insert into private.app_settings (key, value, updated_at) values ('app_base_url', p_url, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
    values (auth.uid(), 'settings.app_base_url', 'app_settings', 'app_base_url', jsonb_build_object('url', p_url));
end $$;
revoke all on function public.set_app_base_url(text) from public, anon;
grant execute on function public.set_app_base_url(text) to authenticated, service_role;