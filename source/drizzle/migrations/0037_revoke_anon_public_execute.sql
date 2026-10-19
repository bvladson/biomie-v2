-- RPC audit (19/10/2026): 24 SECURITY INVOKER functions (read models and pure
-- helpers) were still executable by PUBLIC/anon. RLS and table grants kept them
-- harmless, but anon never needs them. Explicit grants preserve what
-- authenticated/service_role already had; then PUBLIC/anon lose EXECUTE on every
-- public function, and new functions no longer get EXECUTE for PUBLIC by default.
do $$
declare r record;
begin
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) args,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') service_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.prorettype <> 'pg_catalog.trigger'::regtype
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    if r.auth_exec then
      execute format('grant execute on function public.%I(%s) to authenticated', r.proname, r.args);
    end if;
    if r.service_exec then
      execute format('grant execute on function public.%I(%s) to service_role', r.proname, r.args);
    end if;
    execute format('revoke execute on function public.%I(%s) from public, anon', r.proname, r.args);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public;
notify pgrst, 'reload schema';
