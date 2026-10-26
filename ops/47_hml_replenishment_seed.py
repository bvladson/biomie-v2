"""Prazo de reposição HIPOTÉTICO na cópia da homologação, para exercitar a Reposição Inteligente com
dados reais. Só escreve no banco biomie_v2_hml (recusa qualquer outro) e marca a justificativa como
teste: "não é prazo informado pelo usuário". Nunca usar na produção: lá o prazo vem de quem compra.

    python ops/remote.py ops/47_hml_replenishment_seed.py [dias=30]
"""
import json
import subprocess
import sys

DB = 'biomie_v2_hml'
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 30
if not 1 <= DAYS <= 365:
    raise SystemExit('prazo de 1 a 365 dias')
SQL = f"""
begin;
insert into private.intel_replenishment_params (company_id, scope, scope_key, lead_time_days, review_days,
  service_level, reason, updated_by)
select c.id, 'empresa', '', {DAYS}, 30, 0.90,
  'Teste de homologação: prazo hipotético de {DAYS} dias, não informado pelo usuário', null
from public.companies c join private.stock_current sc on sc.company_id = c.id
where not c.is_demo
on conflict (company_id, scope, scope_key) do nothing;
select json_build_object('db', current_database(), 'params', (select json_agg(json_build_object(
  'company', c.slug, 'leadTimeDays', p.lead_time_days, 'reason', p.reason) order by c.slug)
  from private.intel_replenishment_params p join public.companies c on c.id = p.company_id))::text;
commit;
"""
p = subprocess.run(['docker', 'compose', '--env-file', '/opt/biomie-v2/shared/stack.env', '-f',
                    '/opt/biomie-v2/compose.yml', 'exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB,
                    '-At', '-v', 'ON_ERROR_STOP=1'], input=SQL, capture_output=True, text=True, timeout=300)
if p.returncode:
    raise SystemExit(p.stderr[-1500:])
print(json.dumps(json.loads([line for line in p.stdout.splitlines() if line.startswith('{')][-1]), indent=1,
                 ensure_ascii=False))
