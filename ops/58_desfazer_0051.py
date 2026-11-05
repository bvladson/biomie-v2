"""Desfaz a 0051_fact_sales_performance num banco quando a release de destino não a conhece.

    python ops/remote.py ops/58_desfazer_0051.py <release com a 0051> <release de destino> --db=biomie_v2_hml|biomie_v2

Usado nos retornos do noturno (teste de retorno da homologação e retorno automático da ativação). Reativar a
release anterior NÃO desfaz a 0051 (o 21 só aplica as migrações que conhece e não desfaz as outras); os números
são os mesmos nas duas versões, só o tempo muda, mas o retorno tem de devolver o banco ao estado de antes.

Devolve skipped quando não há o que desfazer: a release de destino também tem a 0051, ou a 0051 não está nesse
banco (nem a linha da migração, nem as funções novas, nem o índice). Senão, numa transação só (psql -1): roda o
deploy/db/rollback/0051_fact_sales_performance.down.sql da release que a trouxe (invoice_item_amounts e fact_sales
da 0021, flight_plan_v2_dataset da 0050, índice removido) e apaga a linha da 0051 em private.vps_schema_migrations
(a próxima ativação de uma release com a 0051 a aplica de novo). Confere depois: nada da 0051 sobrou.
Leve (só DDL de funções e um índice): roda a qualquer hora, inclusive num retorno de madrugada.
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
TAG = '0051_fact_sales_performance'
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
DB = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--db=')), None)
if len(ARGS) != 2 or DB not in ('biomie_v2_hml', 'biomie_v2') or not all(re.fullmatch(r'[0-9a-f]{12}', a) for a in ARGS):
    raise SystemExit('uso: 58_desfazer_0051.py <release com a 0051> <release de destino> --db=biomie_v2_hml|biomie_v2')
SRC_REL, DST_REL = (BASE / 'releases' / a for a in ARGS)

STATE = f"""select json_build_object(
  'migracao', exists(select 1 from private.vps_schema_migrations where name like '{TAG}%'),
  'indice', to_regclass('public.invoices_company_customer_date_idx') is not null,
  'factSalesNova', coalesce(position('ok as materialized' in pg_get_functiondef(
      to_regprocedure('public.fact_sales(uuid,date,date,uuid,uuid,uuid,text,text,text)'))) > 0, false),
  'itemAmountsNova', coalesce(position('flags as materialized' in pg_get_functiondef(
      to_regprocedure('public.invoice_item_amounts(uuid,date,date)'))) > 0, false),
  'planoNovo', coalesce(position('cur_customers as materialized' in pg_get_functiondef(
      to_regprocedure('public.flight_plan_v2_dataset(uuid,int,int,jsonb,text,uuid,date,uuid,uuid,text,text,text)'))) > 0, false))"""


def psql(sql, single=False):
    cmd = COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1']
    p = subprocess.run(cmd + (['-1'] if single else []), input=sql, capture_output=True, text=True, timeout=600)
    if p.returncode:
        raise SystemExit(json.dumps({'database': DB, 'ok': False, 'error': (p.stderr or p.stdout)[-1500:]},
                                    ensure_ascii=False))
    return p.stdout


def state():
    return json.loads([x for x in psql(STATE).splitlines() if x.startswith('{')][-1])


out = {'database': DB, 'releaseCom0051': ARGS[0], 'destino': ARGS[1]}
out['antes'] = before = state()
if (DST_REL / 'drizzle' / 'migrations' / f'{TAG}.sql').exists():
    out.update(ok=True, skipped='a release de destino também tem a 0051: nada a desfazer')
elif not any(before.values()):
    out.update(ok=True, skipped='a 0051 não está neste banco: nada a desfazer')
else:
    down = SRC_REL / 'deploy' / 'db' / 'rollback' / f'{TAG}.down.sql'
    if not down.exists():
        raise SystemExit(json.dumps({**out, 'ok': False, 'error': f'retorno ausente: {down}'}, ensure_ascii=False))
    psql(down.read_text(encoding='utf-8')
         + f"\ndelete from private.vps_schema_migrations where name like '{TAG}%';\n", single=True)
    out['depois'] = after = state()
    out['desfeita'] = True
    out['ok'] = not any(after.values())
    if not out['ok']:
        out['error'] = 'sobrou parte da 0051: ' + ', '.join(k for k, v in after.items() if v)
print(json.dumps(out, ensure_ascii=False, indent=1))
if not out['ok']:
    raise SystemExit(3)
