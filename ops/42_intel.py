"""BIOMIE Intelligence na PRODUÇÃO: motor Python (migração 0044) em contêiner avulso.

    python ops/remote.py ops/42_intel.py status
    python ops/remote.py ops/42_intel.py run [--force]     # constrói a imagem da release ativa e roda uma vez
    python ops/remote.py ops/42_intel.py enable|disable    # execuções agendadas (o motor nasce DESLIGADO)

O motor só lê o banco pelas funções stock_intel_* (gateway interno, chave de serviço do stack.env, que
nunca é impressa) e grava apenas as tabelas da inteligência; publica tudo de uma vez no fim. Não fala
com o Omie, não compra, não transfere e não muda preço. Contêiner com 0,5 CPU e 512 MB.
"run" sem --force respeita o "desligado"; "run --force" é a execução de operação (trigger ops).
"""
import json
import pathlib
import subprocess
import sys
import time

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml'), '--profile', 'jobs']
CMD = sys.argv[1] if len(sys.argv) > 1 else 'status'


def secrets():
    return [v for v in (line.split('=', 1)[1] for line in ENV.read_text().splitlines() if '=' in line) if len(v) > 12]


def clean(text):
    for value in secrets():
        text = text.replace(value, '[REDACTED]')
    return text


def run(cmd, timeout=900, check=True):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise SystemExit('FAILED ' + ' '.join(cmd[-4:]) + ': ' + clean((p.stderr or '') + (p.stdout or ''))[-2500:])
    return p


def psql(sql):
    return run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At',
                          '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.strip()


def status():
    return json.loads(psql("""select json_build_object(
      'enabled', (select enabled from private.intel_settings where id),
      'runs', (select coalesce(json_agg(json_build_object('status', r.status, 'trigger', r.trigger,
                 'started', r.started_at, 'seconds', round(extract(epoch from r.finished_at - r.started_at)),
                 'version', r.algorithm_version, 'error', r.error) order by r.started_at desc), '[]')
               from (select * from private.intel_runs order by started_at desc limit 5) r),
      'current', (select coalesce(json_agg(json_build_object('company', c.slug, 'publishedAt', ic.published_at,
                    'products', (select count(*) from private.intel_product_metrics m
                                 where m.run_id = ic.run_id and m.company_id = ic.company_id)) order by c.slug), '[]')
                  from private.intel_current ic join public.companies c on c.id = ic.company_id),
      'snapshots', (select count(*) from private.stock_snapshots),
      'release', (select max(name) from private.vps_schema_migrations))"""))


if CMD == 'status':
    out = status()
elif CMD == 'run':
    release = dict(line.split('=', 1) for line in ENV.read_text().splitlines() if '=' in line)['RELEASE_ID']
    started = time.time()
    run(COMPOSE + ['build', 'intelligence'], timeout=1800)
    built = round(time.time() - started)
    started = time.time()
    args = ['run', '--trigger', 'ops'] + (['--force'] if '--force' in sys.argv else [])
    p = run(COMPOSE + ['run', '--rm', '--no-deps', 'intelligence'] + args, timeout=1800, check=False)
    out = {'release': release, 'image': f'biomie-v2-intel:{release}', 'buildSeconds': built,
           'runSeconds': round(time.time() - started), 'exit': p.returncode,
           'stdout': clean(p.stdout)[-20000:], 'stderr': clean(p.stderr)[-2000:], 'after': status()}
elif CMD in ('enable', 'disable'):
    psql(f"select stock_internal.intel_set_enabled({'true' if CMD == 'enable' else 'false'});")
    out = status()
else:
    raise SystemExit(__doc__)
print(json.dumps(out, indent=1, ensure_ascii=False, default=str))
