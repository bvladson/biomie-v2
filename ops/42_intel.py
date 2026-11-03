"""BIOMIE Intelligence na PRODUÇÃO: motor Python (migração 0044) em contêiner avulso.

    python ops/remote.py ops/42_intel.py status
    python ops/remote.py ops/42_intel.py run [--force]     # constrói a imagem da release ativa e roda uma vez
    python ops/remote.py ops/42_intel.py enable|disable    # liga/desliga a análise diária (nasce DESLIGADA)

Análise diária (rotina do servidor ops/intel_diaria.py, instalada em /opt/biomie-v2/bin/intel_diaria.py):

    python ops/remote.py ops/42_intel.py agenda status
    python ops/remote.py ops/42_intel.py agenda instalar --sha256=<hash da rotina enviada>
    python ops/remote.py ops/42_intel.py agenda remover    # tira o cron (rotina e logs ficam como evidência)
    python ops/remote.py ops/42_intel.py agenda executar [--se-faltar|--verificar|--alvo=copia ...]
    python ops/remote.py ops/42_intel.py parar             # derruba um motor rodando e marca a execução como falha

Cron /etc/cron.d/biomie-v2-intel (fuso do servidor, America/Fortaleza = Brasília): 06:33 análise, 07:03 nova
tentativa só se a de hoje não saiu, 07:35 verificação (alerta WARN no log do monitor de saúde se não saiu).
Desligar na hora: `disable` (a rotina passa a não rodar o motor) + `agenda remover`; com execução em
andamento, `parar` antes. A tela continua com a última análise publicada.

O motor só lê o banco pelas funções stock_intel_* (gateway interno, chave de serviço do stack.env, que
nunca é impressa) e grava apenas as tabelas da inteligência; publica tudo de uma vez no fim. Não fala
com o Omie, não compra, não transfere e não muda preço. Contêiner com 0,5 CPU e 512 MB.
"run" sem --force respeita o "desligado"; "run --force" é a execução de operação (trigger ops).
"""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml'), '--profile', 'jobs']
RUNNER = BASE / 'bin' / 'intel_diaria.py'
CRON = pathlib.Path('/etc/cron.d/biomie-v2-intel')
ROTATE = pathlib.Path('/etc/logrotate.d/biomie-v2-intel')
STATUS = BASE / 'ops' / 'intel-diaria.json'
LOG = pathlib.Path('/var/log/biomie-v2-intel.log')
PIN = 'biomie-v2-intel-reserva'
CRON_TEXT = """# BIOMIE v2 - analise diaria da Inteligencia do Estoque (instalado por ops/42_intel.py agenda instalar)
# Liga/desliga: python ops/remote.py ops/42_intel.py enable|disable (desligada, a rotina nao roda o motor).
# Retirar: python ops/remote.py ops/42_intel.py agenda remover. Situacao: /opt/biomie-v2/ops/intel-diaria.json
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
33 6 * * * root /usr/bin/python3 /opt/biomie-v2/bin/intel_diaria.py >/dev/null 2>>/var/log/biomie-v2-intel.log
3 7 * * * root /usr/bin/python3 /opt/biomie-v2/bin/intel_diaria.py --se-faltar >/dev/null 2>>/var/log/biomie-v2-intel.log
35 7 * * * root /usr/bin/python3 /opt/biomie-v2/bin/intel_diaria.py --verificar >/dev/null 2>>/var/log/biomie-v2-intel.log
"""
ROTATE_TEXT = """/var/log/biomie-v2-intel.log {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    copytruncate
}
"""


def secrets():
    return [v for v in (line.split('=', 1)[1] for line in ENV.read_text().splitlines() if '=' in line) if len(v) > 12]


def clean(text):
    for value in secrets():
        text = text.replace(value, '[REDACTED]')
    return text


def run(cmd, timeout=900, check=True):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
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
      'snapshotDays', (select coalesce(json_agg(d order by d), '[]') from (select distinct day as d
                       from private.stock_snapshots) s),
      'curveHistoryByDay', (select coalesce(json_object_agg(d, n), '{}') from (select day::text as d, count(*) as n
                            from private.stock_curve_history group by day) h),
      'release', (select max(name) from private.vps_schema_migrations))"""))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def agenda_status():
    cron_lines = [line for line in CRON.read_text().splitlines() if line and not line.startswith('#')] \
        if CRON.exists() else []
    try:
        situation = json.loads(STATUS.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        situation = None
    log_tail = LOG.read_text(encoding='utf-8', errors='replace').splitlines()[-15:] if LOG.exists() else []
    pin = run(['docker', 'inspect', PIN, '--format', '{{.Config.Image}} {{.State.Status}}'], check=False)
    return {'cron': {'installed': CRON.exists(), 'sha256': sha256(CRON), 'lines': cron_lines,
                     'expected': CRON.exists() and CRON.read_text() == CRON_TEXT},
            'runner': {'path': str(RUNNER), 'exists': RUNNER.exists(), 'sha256': sha256(RUNNER),
                       'bytes': RUNNER.stat().st_size if RUNNER.exists() else None},
            'logrotate': ROTATE.exists(), 'pin': pin.stdout.strip() if pin.returncode == 0 else None,
            'situation': situation, 'logTail': [clean(line)[:400] for line in log_tail], 'engine': status()}


def runner_call(args, timeout=3600):
    if not RUNNER.exists():
        raise SystemExit(f'rotina ausente: {RUNNER} (envie primeiro)')
    p = run(['python3', str(RUNNER)] + args, timeout=timeout, check=False)
    events = []
    for line in p.stdout.splitlines():
        if line.startswith('{'):
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
    final = next((e.get('situacao') for e in reversed(events) if e.get('event') == 'fim'), None)
    return {'exit': p.returncode, 'situacao': final, 'events': [e for e in events if e.get('event') != 'fim'],
            'stderr': clean(p.stderr)[-1500:]}


def parar():
    """Desligamento imediato de uma execução em andamento: derruba o contêiner do motor (diário ou manual) e
    marca a execução como falha; a tela continua com a análise anterior."""
    ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=biomie-v2',
               '--filter', 'label=com.docker.compose.service=intelligence'], check=False).stdout.split()
    for cid in ids:
        run(['docker', 'kill', cid], check=False)
    time.sleep(2)
    psql("""select stock_internal.intel_fail(r.id, 'Interrompida pela operação (ops/42_intel.py parar).')
            from private.intel_runs r where r.status = 'running';""")
    return {'killedContainers': len(ids), 'after': status()}


CMD = sys.argv[1] if len(sys.argv) > 1 else 'status'
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
elif CMD == 'parar':
    out = parar()
elif CMD == 'agenda':
    sub = sys.argv[2] if len(sys.argv) > 2 else 'status'
    if sub == 'status':
        out = agenda_status()
    elif sub == 'instalar':
        expected = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--sha256=')), '')
        if not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise SystemExit('agenda instalar --sha256=<hash de 64 caracteres da rotina enviada>')
        if sha256(RUNNER) != expected:
            raise SystemExit(f'a rotina em {RUNNER} não é a enviada (sha256 {sha256(RUNNER)}): nada instalado')
        RUNNER.chmod(0o700)
        LOG.touch(exist_ok=True)
        LOG.chmod(0o640)
        ROTATE.write_text(ROTATE_TEXT)
        ROTATE.chmod(0o644)
        CRON.write_text(CRON_TEXT)
        CRON.chmod(0o644)
        out = agenda_status()
    elif sub == 'remover':
        CRON.unlink(missing_ok=True)
        ROTATE.unlink(missing_ok=True)
        out = agenda_status()
    elif sub == 'executar':
        out = runner_call(sys.argv[3:])
    else:
        raise SystemExit(__doc__)
else:
    raise SystemExit(__doc__)
print(json.dumps(out, indent=1, ensure_ascii=False, default=str))
