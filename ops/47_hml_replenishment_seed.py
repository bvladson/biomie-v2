"""Prazo de entrega HIPOTÉTICO na cópia da homologação, para exercitar a Reposição Inteligente com dados
reais. Só escreve no banco biomie_v2_hml (recusa qualquer outro) e marca tudo como teste: "não é prazo
informado pelo usuário". Nunca usar na produção: lá o prazo vem de Compras, pela tela.

    python ops/remote.py ops/47_hml_replenishment_seed.py [dias=30]

Modelo de fornecedores (0048/0049): prazo PADRÃO de teste (status 'teste') para cada fornecedor com produto
vinculado na leitura publicada, e o ajuste stock.test_lead_times = on, que só a cópia tem (o motor só lê
prazo de teste com ele; a tela mostra "prazo configurado na simulação"). Prazo informado por alguém na
cópia não é tocado. Modelo anterior (0048 de 25/10): um parâmetro por empresa, como antes.
"""
import json
import subprocess
import sys

DB = 'biomie_v2_hml'
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 30
if not 1 <= DAYS <= 365:
    raise SystemExit('prazo de 1 a 365 dias')
NOTE = f'Teste de homologação: prazo hipotético de {DAYS} dias, não informado pelo usuário'
CMD = ['docker', 'compose', '--env-file', '/opt/biomie-v2/shared/stack.env', '-f', '/opt/biomie-v2/compose.yml',
       'exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1']

SUPPLIERS = f"""
begin;
do $$ begin
  if current_database() <> '{DB}' then raise exception 'só na cópia da homologação'; end if;
end $$;
insert into private.stock_lead_times (company_id, supplier_id, omie_product_id, lead_time_days, status, note)
select distinct ps.company_id, ps.supplier_id, '', {DAYS}, 'teste', '{NOTE}'
from private.stock_product_suppliers ps
join private.stock_current sc on sc.company_id = ps.company_id
join public.companies c on c.id = ps.company_id and not c.is_demo
where exists (select 1 from private.stock_positions sp where sp.reading_id = sc.reading_id
              and sp.omie_product_id = ps.omie_product_id)
on conflict (company_id, supplier_id, omie_product_id) do nothing;
insert into private.app_settings (key, value, updated_at) values ('stock.test_lead_times', 'on', now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
select json_build_object('db', current_database(), 'model', 'fornecedores', 'testLeadTimesOn', true,
  'leadTimes', (select json_agg(json_build_object('company', c.slug, 'status', t.status, 'suppliers', t.n)
                 order by c.slug, t.status)
                from (select company_id, status, count(*) n from private.stock_lead_times group by 1, 2) t
                join public.companies c on c.id = t.company_id))::text;
commit;
"""

LEGACY = f"""
begin;
insert into private.intel_replenishment_params (company_id, scope, scope_key, lead_time_days, review_days,
  service_level, reason, updated_by)
select c.id, 'empresa', '', {DAYS}, 30, 0.90, '{NOTE}', null
from public.companies c join private.stock_current sc on sc.company_id = c.id
where not c.is_demo
on conflict (company_id, scope, scope_key) do nothing;
select json_build_object('db', current_database(), 'model', 'anterior', 'params', (select json_agg(json_build_object(
  'company', c.slug, 'leadTimeDays', p.lead_time_days, 'reason', p.reason) order by c.slug)
  from private.intel_replenishment_params p join public.companies c on c.id = p.company_id))::text;
commit;
"""

probe = subprocess.run(CMD, input="select to_regclass('private.stock_lead_times') is not null;",
                       capture_output=True, text=True, timeout=120)
if probe.returncode:
    raise SystemExit(probe.stderr[-1500:])
SQL = SUPPLIERS if probe.stdout.strip().endswith('t') else LEGACY
p = subprocess.run(CMD, input=SQL, capture_output=True, text=True, timeout=300)
if p.returncode:
    raise SystemExit(p.stderr[-1500:])
print(json.dumps(json.loads([line for line in p.stdout.splitlines() if line.startswith('{')][-1]), indent=1,
                 ensure_ascii=False))
