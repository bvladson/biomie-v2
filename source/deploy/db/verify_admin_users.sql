\set ON_ERROR_STOP on
-- Admin 2.0 (migração 0040): quem pode o quê, garantido no banco.
-- Empresas e usuários sintéticos; tudo é desfeito no fim. Rodar no banco de TESTE.
begin;
do $$
declare
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  su uuid := gen_random_uuid(); aa uuid := gen_random_uuid(); ab uuid := gen_random_uuid(); aa2 uuid := gen_random_uuid();
  ve uuid := gen_random_uuid(); vi uuid := gen_random_uuid(); vi2 uuid := gen_random_uuid(); bl uuid := gen_random_uuid();
  nu uuid := gen_random_uuid(); ol uuid := gen_random_uuid();
  sa1 uuid := gen_random_uuid(); sa2 uuid := gen_random_uuid(); sa3 uuid := gen_random_uuid(); sb1 uuid := gen_random_uuid();
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis) values
    (ca, 'Empresa A (teste)', 'adm-a-' || ca, 'OMIE_SHADOW', 'commercial_base'),
    (cb, 'Empresa B (teste)', 'adm-b-' || cb, 'OMIE_SHADOW', 'commercial_base');
  insert into auth.users (id, email, created_at) values
    (su, 'su-' || su || '@invalid.example', now() - interval '30 days'),
    (aa, 'aa-' || aa || '@invalid.example', now() - interval '30 days'),
    (ab, 'ab-' || ab || '@invalid.example', now() - interval '30 days'),
    (aa2, 'aa2-' || aa2 || '@invalid.example', now() - interval '30 days'),
    (ve, 've-' || ve || '@invalid.example', now() - interval '30 days'),
    (vi, 'vi-' || vi || '@invalid.example', now() - interval '30 days'),
    (vi2, 'vi2-' || vi2 || '@invalid.example', now() - interval '30 days'),
    (bl, 'bl-' || bl || '@invalid.example', now() - interval '30 days'),
    (ol, 'ol-' || ol || '@invalid.example', now() - interval '1 day'),
    (nu, 'nu-' || nu || '@invalid.example', now());
  update auth.users set banned_until = now() + interval '100 years' where id = bl;
  insert into public.profiles (id, email, full_name) values
    (su, 'su@x', 'Super Teste'), (aa, 'aa@x', 'Admin A'), (ab, 'ab@x', 'Admin B'), (aa2, 'aa2@x', 'Admin A2'),
    (ve, 've@x', 'Vendedor A'), (vi, 'vi@x', 'Visualizador A'), (vi2, 'vi2@x', 'Visualizador AB'), (bl, 'bl@x', 'Bloqueado A');
  insert into public.user_roles (user_id, role) values
    (su, 'SUPER_ADMIN'), (aa, 'ADMIN'), (ab, 'ADMIN'), (aa2, 'ADMIN'), (ve, 'VENDEDOR'), (vi, 'VIEWER'), (vi2, 'VIEWER'), (bl, 'VIEWER');
  insert into public.user_company_access (user_id, company_id) values
    (aa, ca), (ab, cb), (aa2, ca), (ve, ca), (vi, ca), (vi2, ca), (vi2, cb), (bl, ca);
  insert into public.sellers (id, company_id, name, active, user_id) values
    (sa1, ca, 'Vendedor A1', true, ve), (sa2, ca, 'Vendedor A2', true, null),
    (sa3, ca, 'Vendedor A3', false, null), (sb1, cb, 'Vendedor B1', true, null);
  insert into public.sales_teams (id, company_id, name) values (ta, ca, 'Equipe A'), (tb, cb, 'Equipe B');
  perform set_config('adm.ca', ca::text, true); perform set_config('adm.cb', cb::text, true);
  perform set_config('adm.su', su::text, true); perform set_config('adm.aa', aa::text, true);
  perform set_config('adm.ab', ab::text, true); perform set_config('adm.aa2', aa2::text, true);
  perform set_config('adm.ve', ve::text, true); perform set_config('adm.vi', vi::text, true);
  perform set_config('adm.vi2', vi2::text, true); perform set_config('adm.bl', bl::text, true);
  perform set_config('adm.nu', nu::text, true); perform set_config('adm.ol', ol::text, true);
  perform set_config('adm.sa1', sa1::text, true); perform set_config('adm.sa2', sa2::text, true);
  perform set_config('adm.sa3', sa3::text, true); perform set_config('adm.sb1', sb1::text, true);
  perform set_config('adm.ta', ta::text, true); perform set_config('adm.tb', tb::text, true);
end $$;

-- 1. Vendedor: não entra no Admin, nem chamando a API direto; Minha conta continua liberada.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('adm.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin perform public.admin_users(); raise exception 'FALHOU: vendedor listou usuários';
  exception when others then if sqlerrm not like '%Acesso restrito a administradores%' then raise; end if; end;
  begin perform public.admin_update_access(current_setting('adm.vi')::uuid, '{"roles":["SUPER_ADMIN"]}');
    raise exception 'FALHOU: vendedor alterou acesso';
  exception when others then if sqlerrm not like '%Acesso restrito a administradores%' then raise; end if; end;
  begin perform public.admin_audit('{}'); raise exception 'FALHOU: vendedor leu a auditoria';
  exception when others then if sqlerrm not like '%Acesso restrito a administradores%' then raise; end if; end;
  begin perform public.admin_save_holiday('{"date":"2030-01-02","name":"x","scope":"national"}'); raise exception 'FALHOU: vendedor gravou feriado';
  exception when others then if sqlerrm not like '%Acesso restrito a administradores%' then raise; end if; end;
  if public.my_update_name('Vendedor A Renomeado')->>'fullName' <> 'Vendedor A Renomeado' then
    raise exception 'FALHOU: Minha conta não alterou o nome';
  end if;
  if has_function_privilege('authenticated', 'admin_internal.apply_access(uuid,jsonb,boolean,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'admin_internal.log(text,text,text,uuid,jsonb,jsonb)', 'EXECUTE') then
    raise exception 'FALHOU: auxiliar interno executável pela API';
  end if;
end $$;
reset role;

-- 2. Admin B grava um feriado da empresa B (a auditoria do Admin A não pode mostrar).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('adm.ab'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  perform public.admin_save_holiday(jsonb_build_object('date', '2030-05-05', 'name', 'Feriado B', 'scope', 'company',
    'companyId', current_setting('adm.cb')));
end $$;
reset role;

-- 3. Admin A: só a própria empresa, sem papéis e sem outro Admin.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('adm.aa'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ids text[]; u jsonb; acc jsonb;
begin
  v := public.admin_users();
  select array_agg(x->>'id') into ids from jsonb_array_elements(v) as e(x);
  if not current_setting('adm.ve') = any(ids) or not current_setting('adm.vi2') = any(ids) then
    raise exception 'FALHOU: Admin A não vê os usuários da empresa A';
  end if;
  if current_setting('adm.ab') = any(ids) or current_setting('adm.su') = any(ids) then
    raise exception 'FALHOU: Admin A vê usuário de fora das suas empresas';
  end if;
  select x into u from jsonb_array_elements(v) as e(x) where x->>'id' = current_setting('adm.vi2');
  if u->'companyIds' <> jsonb_build_array(current_setting('adm.ca')) or (u->>'otherCompanyCount')::int <> 1 then
    raise exception 'FALHOU: empresas de fora apareceram para o Admin A: %', u;
  end if;
  begin perform public.admin_user(current_setting('adm.ab')::uuid); raise exception 'FALHOU: Admin A abriu o Admin B';
  exception when others then if sqlerrm not like '%Usuário não encontrado%' then raise; end if; end;
  begin perform public.admin_update_access(current_setting('adm.aa2')::uuid, '{"permissions":["finance.export"]}');
    raise exception 'FALHOU: Admin alterou outro Admin';
  exception when others then if sqlerrm not like '%Admin não altera outro Admin%' then raise; end if; end;
  begin perform public.admin_update_access(current_setting('adm.vi')::uuid, '{"roles":["VIEWER","ANALISTA"]}');
    raise exception 'FALHOU: Admin alterou papel';
  exception when others then if sqlerrm not like '%Somente o Super admin altera papéis%' then raise; end if; end;
  begin perform public.admin_update_access(current_setting('adm.vi')::uuid,
      jsonb_build_object('companyIds', jsonb_build_array(current_setting('adm.ca'), current_setting('adm.cb'))));
    raise exception 'FALHOU: Admin concedeu a empresa B';
  exception when others then if sqlerrm not like '%não pode conceder a empresa%' then raise; end if; end;
  begin perform public.admin_update_access(current_setting('adm.vi')::uuid, '{"companyIds":[]}');
    raise exception 'FALHOU: usuário ficou sem empresa';
  exception when others then if sqlerrm not like '%pelo menos uma empresa%' then raise; end if; end;
  -- Tirar a empresa A de quem também tem a B: a B (fora do alcance do Admin A) fica.
  perform public.admin_update_access(current_setting('adm.vi2')::uuid, '{"companyIds":[]}');

  -- Criação: ensaio com as regras.
  acc := jsonb_build_object('roles', jsonb_build_array('ADMIN'), 'companyIds', jsonb_build_array(current_setting('adm.ca')));
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email', 'novo@invalid.example',
      'delivery', 'INVITE_LINK', 'access', acc)); raise exception 'FALHOU: Admin criaria outro Admin';
  exception when others then if sqlerrm not like '%não pode criar usuários com o papel Admin%' then raise; end if; end;
  acc := jsonb_build_object('roles', jsonb_build_array('VIEWER'), 'companyIds', jsonb_build_array(current_setting('adm.cb')));
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email', 'novo@invalid.example',
      'delivery', 'INVITE_LINK', 'access', acc)); raise exception 'FALHOU: Admin criaria na empresa B';
  exception when others then if sqlerrm not like '%não pode conceder a empresa%' then raise; end if; end;
  acc := jsonb_build_object('roles', jsonb_build_array('VENDEDOR'), 'companyIds', jsonb_build_array(current_setting('adm.ca')));
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email', 'novo@invalid.example',
      'delivery', 'INVITE_LINK', 'access', acc)); raise exception 'FALHOU: Vendedor sem vendedor do Omie';
  exception when others then if sqlerrm not like '%precisa estar vinculado a um vendedor do Omie%' then raise; end if; end;
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email', 'novo@invalid.example',
      'delivery', 'INVITE_LINK', 'access', acc || jsonb_build_object('sellerIds', jsonb_build_array(current_setting('adm.sa1')))));
    raise exception 'FALHOU: vendedor do Omie já ligado a outro login';
  exception when others then if sqlerrm not like '%já tem login vinculado%' then raise; end if; end;
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email', 'novo@invalid.example',
      'delivery', 'INVITE_LINK', 'access', acc || jsonb_build_object('sellerIds', jsonb_build_array(current_setting('adm.sa3')))));
    raise exception 'FALHOU: vendedor do Omie inativo';
  exception when others then if sqlerrm not like '%inativo no Omie%' then raise; end if; end;
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email', 'novo@invalid.example',
      'delivery', 'INVITE_LINK', 'access', acc || jsonb_build_object('sellerIds', jsonb_build_array(current_setting('adm.sb1')))));
    raise exception 'FALHOU: vendedor do Omie de outra empresa';
  exception when others then if sqlerrm not like '%empresa que o usuário não acessa%' then raise; end if; end;
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email',
      upper('ve-' || current_setting('adm.ve') || '@invalid.example'), 'delivery', 'INVITE_LINK', 'access', acc));
    raise exception 'FALHOU: e-mail repetido';
  exception when others then if sqlerrm not like '%E-mail já cadastrado%' then raise; end if; end;
  begin perform public.admin_validate_new_user(jsonb_build_object('fullName', 'Novo', 'email', 'novo@invalid.example',
      'username', 'A B', 'delivery', 'INVITE_LINK', 'access', acc)); raise exception 'FALHOU: nome de usuário inválido';
  exception when others then if sqlerrm not like '%Nome de usuário%' then raise; end if; end;

  -- Criação de verdade: Vendedor da empresa A, convite por link.
  acc := acc || jsonb_build_object('sellerIds', jsonb_build_array(current_setting('adm.sa2')),
    'defaultCompanyId', current_setting('adm.ca'), 'permissions', jsonb_build_array('finance.view_titles'));
  u := public.admin_provision_user(current_setting('adm.nu')::uuid, jsonb_build_object('fullName', 'Novo Vendedor',
    'email', 'nu-' || current_setting('adm.nu') || '@invalid.example', 'username', 'vendedor.novo',
    'delivery', 'INVITE_LINK', 'expiresAt', now() + interval '24 hours', 'access', acc));
  if u->>'status' <> 'INVITED' or u->'roles' <> '["VENDEDOR"]'::jsonb
     or u->'sellerIds' <> jsonb_build_array(current_setting('adm.sa2')) or u->>'username' <> 'vendedor.novo' then
    raise exception 'FALHOU: conta criada diferente do pedido: %', u;
  end if;
  begin perform public.admin_provision_user(current_setting('adm.nu')::uuid, jsonb_build_object('fullName', 'Outro',
      'email', 'nu-' || current_setting('adm.nu') || '@invalid.example', 'delivery', 'INVITE_LINK', 'access', acc));
    raise exception 'FALHOU: reconfigurou conta já configurada';
  exception when others then if sqlerrm not like '%não pode ser configurada%' then raise; end if; end;
  begin perform public.admin_provision_user(current_setting('adm.ol')::uuid, jsonb_build_object('fullName', 'Antigo',
      'email', 'ol-' || current_setting('adm.ol') || '@invalid.example', 'delivery', 'INVITE_LINK',
      'access', jsonb_build_object('roles', jsonb_build_array('VIEWER'), 'companyIds', jsonb_build_array(current_setting('adm.ca')))));
    raise exception 'FALHOU: configurou conta antiga (promoção indevida)';
  exception when others then if sqlerrm not like '%não pode ser configurada%' then raise; end if; end;

  -- Ações no serviço de login: pré-checagens.
  if public.admin_check_action(current_setting('adm.bl')::uuid, 'issue') not like 'Reative o usuário%' then
    raise exception 'FALHOU: gerar acesso para bloqueado';
  end if;
  if public.admin_check_action(current_setting('adm.aa')::uuid, 'block') <> 'Você não pode bloquear a si mesmo.' then
    raise exception 'FALHOU: Admin pode se bloquear';
  end if;
  begin perform public.admin_access_issued(current_setting('adm.bl')::uuid, 'INVITE_LINK', now());
    raise exception 'FALHOU: registrou acesso para bloqueado';
  exception when others then if sqlerrm not like '%Reative o usuário%' then raise; end if; end;
  begin perform public.admin_block_recorded(current_setting('adm.vi')::uuid, true, 'x');
    raise exception 'FALHOU: bloqueio sem motivo';
  exception when others then if sqlerrm not like '%Informe o motivo%' then raise; end if; end;
  perform public.admin_block_recorded(current_setting('adm.vi')::uuid, true, 'Saiu da empresa');
  begin perform public.admin_delete_user(current_setting('adm.vi')::uuid, 'x');
    raise exception 'FALHOU: Admin excluiu usuário';
  exception when others then if sqlerrm not like '%Somente o Super admin exclui%' then raise; end if; end;
  begin perform public.admin_rename_company(current_setting('adm.ca')::uuid, 'Novo nome');
    raise exception 'FALHOU: Admin renomeou empresa';
  exception when others then if sqlerrm not like '%Somente o Super admin altera o nome%' then raise; end if; end;

  -- Feriados: Admin só mexe nos da própria empresa.
  begin perform public.admin_save_holiday('{"date":"2030-01-02","name":"Nacional","scope":"national"}');
    raise exception 'FALHOU: Admin gravou feriado nacional';
  exception when others then if sqlerrm not like '%não pode editar feriados%' then raise; end if; end;
  begin perform public.admin_save_holiday(jsonb_build_object('date', '2030-01-02', 'name', 'B', 'scope', 'company',
      'companyId', current_setting('adm.cb'))); raise exception 'FALHOU: Admin gravou feriado da empresa B';
  exception when others then if sqlerrm not like '%não pode editar feriados%' then raise; end if; end;
  perform public.admin_save_holiday(jsonb_build_object('date', '2030-03-19', 'name', 'Feriado A', 'scope', 'company',
    'companyId', current_setting('adm.ca')));
  begin perform public.admin_save_holiday(jsonb_build_object('date', '2030-03-19', 'name', 'De novo', 'scope', 'company',
      'companyId', current_setting('adm.ca'))); raise exception 'FALHOU: feriado repetido';
  exception when others then if sqlerrm not like '%Já existe um feriado nesta data%' then raise; end if; end;
  v := public.admin_import_holidays(jsonb_build_array(
    jsonb_build_object('date', '2030-03-19', 'name', 'Repetido', 'scope', 'company', 'companyId', current_setting('adm.ca')),
    jsonb_build_object('date', '2030-04-13', 'name', 'Novo', 'scope', 'company', 'companyId', current_setting('adm.ca'))));
  if v <> '{"created": 1, "duplicates": 1}'::jsonb then raise exception 'FALHOU: importação de feriados: %', v; end if;

  -- Auditoria: o Admin A não vê o que aconteceu só na empresa B.
  v := public.admin_audit('{}');
  if exists (select 1 from jsonb_array_elements(v->'rows') as e(x) where x->>'companyId' = current_setting('adm.cb')) then
    raise exception 'FALHOU: Admin A viu auditoria da empresa B';
  end if;
  if not exists (select 1 from jsonb_array_elements(public.admin_audit('{"action":"user.created"}')->'rows') as e(x)
                 where x->>'entityId' = current_setting('adm.nu') and x->>'actorName' = 'Admin A') then
    raise exception 'FALHOU: criação não aparece na auditoria do Admin A';
  end if;
end $$;
reset role;

-- 4. Super admin: papéis, exclusão e as travas de si mesmo.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('adm.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare u jsonb;
begin
  u := public.admin_update_access(current_setting('adm.vi2')::uuid,
    jsonb_build_object('roles', jsonb_build_array('VIEWER', 'GESTOR'), 'managedTeamIds', jsonb_build_array(current_setting('adm.tb'))));
  if u->'managedTeamIds' <> jsonb_build_array(current_setting('adm.tb')) then raise exception 'FALHOU: equipes do gestor: %', u; end if;
  begin perform public.admin_update_access(current_setting('adm.su')::uuid, '{"roles":["VIEWER"]}');
    raise exception 'FALHOU: Super admin tirou o próprio acesso';
  exception when others then if sqlerrm not like '%remover o próprio acesso de administrador%' then raise; end if; end;
  -- Tirar o papel Vendedor desfaz o vínculo com o vendedor do Omie.
  perform public.admin_update_access(current_setting('adm.ve')::uuid, '{"roles":["VIEWER"]}');
  begin perform public.admin_delete_user(current_setting('adm.vi')::uuid, 'errado@invalid.example');
    raise exception 'FALHOU: exclusão com e-mail errado';
  exception when others then if sqlerrm not like '%não confere%' then raise; end if; end;
  begin perform public.admin_delete_user(current_setting('adm.su')::uuid, 'su-' || current_setting('adm.su') || '@invalid.example');
    raise exception 'FALHOU: Super admin se excluiu';
  exception when others then if sqlerrm not like '%excluir a si mesmo%' then raise; end if; end;
  perform public.admin_delete_user(current_setting('adm.vi')::uuid, 'VI-' || current_setting('adm.vi') || '@invalid.example');
  perform public.admin_rename_company(current_setting('adm.ca')::uuid, 'Empresa A renomeada');
  perform public.admin_save_holiday('{"date":"2030-01-02","name":"Nacional de teste","scope":"national"}');
end $$;
reset role;

-- 5. Conferência do que ficou gravado (como dono do banco).
do $$
declare nu uuid := current_setting('adm.nu')::uuid; aa uuid := current_setting('adm.aa')::uuid; su uuid := current_setting('adm.su')::uuid;
begin
  if not exists (select 1 from public.profiles where id = nu and full_name = 'Novo Vendedor')
     or (select array_agg(role::text) from public.user_roles where user_id = nu) <> array['VENDEDOR']
     or (select array_agg(company_id) from public.user_company_access where user_id = nu) <> array[current_setting('adm.ca')::uuid]
     or (select user_id from public.sellers where id = current_setting('adm.sa2')::uuid) is distinct from nu
     or not exists (select 1 from private.legacy_user_aliases where alias = 'vendedor.novo' and user_id = nu and source = 'admin')
     or not exists (select 1 from public.user_permissions where user_id = nu and permission = 'finance.view_titles' and granted_by = aa)
     or (select access_kind from private.user_admin_state where user_id = nu) is distinct from 'INVITE_LINK' then
    raise exception 'FALHOU: conta criada pelo Admin A não ficou como pedido';
  end if;
  if not exists (select 1 from public.audit_log where entity = 'user_roles' and action = 'insert' and entity_id = nu::text and actor_id = aa) then
    raise exception 'FALHOU: papel concedido na criação sem o autor';
  end if;
  if exists (select 1 from public.user_company_access where user_id = current_setting('adm.vi2')::uuid and company_id = current_setting('adm.ca')::uuid)
     or not exists (select 1 from public.user_company_access where user_id = current_setting('adm.vi2')::uuid and company_id = current_setting('adm.cb')::uuid) then
    raise exception 'FALHOU: Admin A mexeu na empresa B de outro usuário';
  end if;
  if (select blocked_reason from private.user_admin_state where user_id = current_setting('adm.vi')::uuid) is distinct from 'Saiu da empresa' then
    raise exception 'FALHOU: motivo do bloqueio não registrado';
  end if;
  if exists (select 1 from public.user_roles where user_id = current_setting('adm.vi')::uuid)
     or exists (select 1 from public.user_company_access where user_id = current_setting('adm.vi')::uuid)
     or (select deleted_by from private.user_admin_state where user_id = current_setting('adm.vi')::uuid) is distinct from su
     or not exists (select 1 from public.audit_log where action = 'user.deleted' and entity_id = current_setting('adm.vi') and actor_id = su) then
    raise exception 'FALHOU: exclusão não retirou o acesso ou não ficou auditada';
  end if;
  if (select user_id from public.sellers where id = current_setting('adm.sa1')::uuid) is not null then
    raise exception 'FALHOU: vínculo de vendedor ficou sem o papel Vendedor';
  end if;
  if not exists (select 1 from public.sales_team_managers where team_id = current_setting('adm.tb')::uuid
                 and user_id = current_setting('adm.vi2')::uuid and valid_to is null) then
    raise exception 'FALHOU: gestão de equipe não gravada';
  end if;
  if (select count(*) from public.holidays where company_id = current_setting('adm.ca')::uuid) <> 2
     or not exists (select 1 from public.holidays where date = '2030-01-02' and scope = 'national') then
    raise exception 'FALHOU: feriados gravados diferentes do esperado';
  end if;
  if has_function_privilege('anon', 'admin_internal.me()', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_users()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.admin_users()', 'EXECUTE') then
    raise exception 'FALHOU: permissões de execução';
  end if;
  raise notice 'PASS Admin 2.0: vendedor barrado, admin restrito às próprias empresas e sem papéis, criação sem promoção indevida, empresas de fora preservadas, vínculos e feriados validados, exclusão só do Super admin, auditoria com autor e isolada por empresa';
end $$;
rollback;
