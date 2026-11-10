\set ON_ERROR_STOP on
-- Assistente MAG AI, migração 0052: chave desligada por padrão; só administradores ligam; perfis
-- liberados decidem quem vê ('ai_assistant' nas features); registro só de metadados com empresa
-- conferida; avaliação só do próprio pedido; resumo só para administradores; retenção agendada.
-- Empresas e usuários sintéticos; tudo é desfeito no fim. Banco de TESTE.
begin;
do $$
declare
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  su uuid := gen_random_uuid(); ad uuid := gen_random_uuid(); ve uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'IA A (teste)', 'ia-a-' || ca, 'OMIE', 'commercial_base', false),
    (cb, 'IA B (teste)', 'ia-b-' || cb, 'OMIE', 'commercial_base', false);
  insert into auth.users (id, email, created_at) values
    (su, 'ia-su-' || su || '@invalid.example', now()),
    (ad, 'ia-ad-' || ad || '@invalid.example', now()),
    (ve, 'ia-ve-' || ve || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values
    (su, 'ia-su@x', 'Super IA'), (ad, 'ia-ad@x', 'Admin IA'), (ve, 'ia-ve@x', 'Vendedor IA');
  insert into public.user_roles (user_id, role) values
    (su, 'SUPER_ADMIN'), (ad, 'ADMIN'), (ve, 'VENDEDOR');
  insert into public.user_company_access (user_id, company_id) values (ad, ca), (ve, ca);
  perform set_config('ia.ca', ca::text, true); perform set_config('ia.cb', cb::text, true);
  perform set_config('ia.su', su::text, true); perform set_config('ia.ad', ad::text, true);
  perform set_config('ia.ve', ve::text, true);
end $$;

-- 1. Desligado por padrão: ninguém vê, ninguém registra (nem o Super admin).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('ia.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if public.ai_assistant_enabled_for_me() then raise exception 'FALHOU: ligado por padrão'; end if;
  if 'ai_assistant' = any(public.my_features()) then raise exception 'FALHOU: feature com a chave desligada'; end if;
  begin
    perform public.ai_request_log(current_setting('ia.ca')::uuid, 'ritmo_plano', 'ok', 'm', 1, 1, 1, 1, 0);
    raise exception 'FALHOU: registro com a chave desligada';
  exception when others then if sqlerrm not like '%desligado%' then raise; end if; end;
end $$;
reset role;

-- 2. Vendedor não liga o assistente; Admin liga (e o audit_log guarda).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('ia.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin
    perform public.ai_assistant_set(true, array['SUPER_ADMIN']);
    raise exception 'FALHOU: vendedor ligou o assistente';
  exception when others then if sqlerrm not like '%administradores%' then raise; end if; end;
  begin
    perform public.ai_assistant_set(true, array['SUPER_ADMIN','HACKER']);
    raise exception 'FALHOU: papel inventado aceito';
  exception when others then if sqlerrm not like '%administradores%' and sqlerrm not like '%desconhecido%' then raise; end if; end;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('ia.ad'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  begin
    perform public.ai_assistant_set(true, array['SUPER_ADMIN','HACKER']);
    raise exception 'FALHOU: papel inventado aceito';
  exception when others then if sqlerrm not like '%desconhecido%' then raise; end if; end;
  v := public.ai_assistant_set(true, array['SUPER_ADMIN', 'ADMIN']);
  if coalesce((v->>'enabled')::boolean, false) is not true then raise exception 'FALHOU: não ligou: %', v; end if;
end $$;
reset role;
do $$
begin
  if not exists (
    select 1 from public.audit_log
    where actor_id = current_setting('ia.ad')::uuid and action = 'ai_assistant_set' and entity_id = 'ai_assistant')
  then raise exception 'FALHOU: audit_log sem o ai_assistant_set'; end if;
end $$;

-- 3. Perfis liberados decidem: Admin e Super veem, Vendedor não.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('ia.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if public.ai_assistant_enabled_for_me() then raise exception 'FALHOU: vendedor fora da lista viu o assistente'; end if;
  if 'ai_assistant' = any(public.my_features()) then raise exception 'FALHOU: feature para vendedor fora da lista'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('ia.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare rid uuid;
begin
  if not public.ai_assistant_enabled_for_me() then raise exception 'FALHOU: super sem assistente ligado'; end if;
  if not ('ai_assistant' = any(public.my_features())) then raise exception 'FALHOU: feature ausente para o super'; end if;
  -- 4. Registro: só metadados, empresa conferida, limites aplicados.
  rid := public.ai_request_log(current_setting('ia.ca')::uuid, 'ritmo_plano', 'ok', 'qwen3.5:0.8b-q8_0', 2000, 12000, 900, 120, 0);
  if rid is null then raise exception 'FALHOU: registro não devolveu id'; end if;
  perform set_config('ia.rid', rid::text, true);
  begin
    perform public.ai_request_log(current_setting('ia.ca')::uuid, 'ritmo_plano', 'status_inventado', 'm', 0, 0, 0, 0, 0);
    raise exception 'FALHOU: status inventado aceito';
  exception when others then
    if sqlerrm not like '%ai_requests_status_check%' then raise; end if; end;
  -- 5. Avaliação do próprio pedido.
  if not public.ai_request_rate(rid, true) then raise exception 'FALHOU: avaliação do próprio pedido'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('ia.ad'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  -- Admin (sem acesso à empresa B) não registra nela.
  begin
    perform public.ai_request_log(current_setting('ia.cb')::uuid, 'ritmo_plano', 'ok', 'm', 1, 1, 1, 1, 0);
    raise exception 'FALHOU: registro em empresa sem acesso';
  exception when others then if sqlerrm not like '%Sem acesso%' then raise; end if; end;
  -- Avaliação de pedido alheio não altera nada.
  if public.ai_request_rate(current_setting('ia.rid')::uuid, false) then
    raise exception 'FALHOU: avaliou pedido de outra pessoa'; end if;
  -- 6. Resumo para administradores.
  v := public.ai_requests_summary(current_setting('ia.ca')::uuid, 7);
  if coalesce((v->>'total')::integer, 0) < 1 or coalesce((v->>'uteis')::integer, 0) <> 1 then
    raise exception 'FALHOU: resumo: %', v; end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('ia.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin
    perform public.ai_requests_summary(null, 7);
    raise exception 'FALHOU: resumo aberto a vendedor';
  exception when others then if sqlerrm not like '%administradores%' then raise; end if; end;
end $$;
reset role;

-- 7. Retenção agendada e metadados sem texto (a tabela não tem coluna de pergunta/resposta).
do $$
begin
  if (select count(*) from cron.job where jobname = 'biomie-ai-requests-retencao') <> 1 then
    raise exception 'FALHOU: retenção não agendada'; end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'ai_requests'
      and column_name in ('question','answer','pergunta','resposta','texto','prompt','content'))
  then raise exception 'FALHOU: coluna de texto em ai_requests'; end if;
end $$;

select 'verify_ai_requests ok' as resultado;
rollback;
