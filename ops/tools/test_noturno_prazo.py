"""Prazo da noite (--ate / --comecar-ate do noturno.py e BIOMIE_JANELA_ATE da janela de testes), sem servidor:
a janela é simulada (relógio e motivos falsos) e o noturno.py roda só com uma tarefa que não entra na fila.
Uso: python test_noturno_prazo.py <worktree>"""
import datetime as dt
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(ROOT / 'ops'))
import janela_testes  # noqa: E402
import noturno  # noqa: E402

TZ = janela_testes.TZ
results = []


def case(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('OK   ' if cond else 'FALHA') + ' ' + name + (('  → ' + detail) if detail and not cond else ''))


# 1. Horário mais próximo do início (até 12 h antes ou depois).
def at(day, hour, minute=0):
    return dt.datetime(2026, 11, day, hour, minute, tzinfo=TZ)


for start, value, want, label in (
        (at(6, 18, 30), '23:00', at(6, 23), '18:30 com --ate=23:00 → hoje 23:00'),
        (at(6, 23, 30), '23:00', at(6, 23), '23:30 com --ate=23:00 → já passou (hoje 23:00)'),
        (at(6, 18, 30), '01:00', at(7, 1), '18:30 com --ate=01:00 → amanhã 01:00'),
        (at(7, 0, 30), '23:00', at(6, 23), '00:30 com --ate=23:00 → ontem 23:00 (já passou)'),
        (at(6, 18, 30), '21:00', at(6, 21), '18:30 com --comecar-ate=21:00 → hoje 21:00')):
    got = noturno.clock_option(['x', f'--ate={value}'], '--ate', start)
    case(label, got == want, str(got))
case('sem a opção → sem prazo', noturno.clock_option(['x', 'y'], '--ate', at(6, 18)) is None)
for bad in ('23h', '25:00', '23:00:00', ''):
    try:
        noturno.clock_option(['x', f'--ate={bad}'], '--ate', at(6, 18))
        case(f'--ate={bad!r} recusado', False, 'aceitou')
    except SystemExit as e:
        case(f'--ate={bad!r} recusado', 'HH:MM' in str(e), str(e))


# 2. Janela com prazo (relógio falso; motivos falsos).
class Clock:
    def __init__(self, now):
        self.now = now
        self.sleeps = 0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps += 1
        self.now += seconds


def guard(script, args, limit, blocked, now=None):
    clock = Clock(now if now is not None else dt.datetime.now(TZ).timestamp())
    janela_testes.time = clock
    janela_testes.reasons = lambda now=None, probe=None: list(blocked)
    if limit is None:
        os.environ.pop(janela_testes.LIMIT_ENV, None)
    else:
        os.environ[janela_testes.LIMIT_ENV] = limit.isoformat()
    try:
        return janela_testes.guard(pathlib.Path(script), list(args)), clock
    except SystemExit as e:
        return str(e), clock


base = dt.datetime(2026, 11, 6, 22, 0, tzinfo=TZ)
past, future = base - dt.timedelta(minutes=5), base + dt.timedelta(minutes=30)
heavy = ['db-refresh', '--esperar']
out, _ = guard('41_homolog.py', heavy, past, [], base.timestamp())
case('prazo vencido: passo pesado recusado', isinstance(out, str) and 'prazo da noite' in out, str(out))
out, _ = guard('41_homolog.py', ['down'], past, [], base.timestamp())
case('prazo vencido: down (leve) segue', out == ['down'], str(out))
out, _ = guard('29_smoke.py', ['--hml', '--esperar'], past, [], base.timestamp())
case('prazo vencido: navegador da homologação recusado', isinstance(out, str) and 'prazo da noite' in out, str(out))
out, _ = guard('41_homolog.py', heavy, future, [], base.timestamp())
case('antes do prazo com janela aberta: começa', out == ['db-refresh'], str(out))
out, clock = guard('41_homolog.py', heavy, future, ['minuto :49 perto das cargas'], base.timestamp())
case('esperando a janela: desiste no prazo', isinstance(out, str) and 'prazo da noite' in out
     and clock.now >= future.timestamp() and clock.sleeps == 30, f'{out} sleeps={clock.sleeps}')
out, clock = guard('41_homolog.py', heavy, None, ['minuto :49 perto das cargas'], base.timestamp())
case('sem prazo: espera até 3 h como antes', isinstance(out, str) and 'recusado agora' in out
     and clock.sleeps >= 180, f'{out} sleeps={clock.sleeps}')
out, _ = guard('41_homolog.py', ['db-refresh'], future, ['minuto :49 perto das cargas'], base.timestamp())
case('sem --esperar: recusa na hora como antes', isinstance(out, str) and 'recusado agora' in out, str(out))
os.environ[janela_testes.LIMIT_ENV] = '2026-11-06T23:00:00'
try:
    janela_testes.night_limit()
    case('prazo sem fuso recusado', False, 'aceitou')
except SystemExit as e:
    case('prazo sem fuso recusado', 'fuso' in str(e), str(e))
os.environ.pop(janela_testes.LIMIT_ENV, None)

# 3. noturno.py de verdade, com uma tarefa que não entra na fila (nada vai ao servidor).
env = {**{k: v for k, v in os.environ.items() if k != janela_testes.LIMIT_ENV}, 'PYTHONIOENCODING': 'utf-8'}
now = dt.datetime.now(TZ)
gone = (now - dt.timedelta(minutes=10)).strftime('%H:%M')
ahead = (now + dt.timedelta(minutes=50)).strftime('%H:%M')
p = subprocess.run([sys.executable, str(ROOT / 'ops' / 'noturno.py'), 'tarefa-inexistente', f'--comecar-ate={gone}'],
                   capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=60)
case('--comecar-ate vencido: desiste sem fazer nada', p.returncode != 0 and 'fica para outra noite' in p.stderr,
     p.stderr[-300:])
p = subprocess.run([sys.executable, str(ROOT / 'ops' / 'noturno.py'), 'tarefa-inexistente', f'--ate={ahead}'],
                   capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=60)
case('--ate: avisa o prazo e segue para a tarefa', f'nenhum passo pesado começa depois de' in p.stderr
     and 'Trabalhos noturnos' in p.stderr, p.stderr[-300:])

# 4. legado-passo2 (servidor simulado): prazo, parada e portão fechado.
import json  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402


class FakeDatetime(dt.datetime):
    fixed = None

    @classmethod
    def now(cls, tz=None):
        return cls.fixed if cls.fixed is not None else dt.datetime.now(tz)


class FakeDt:
    datetime, date, time, timedelta, timezone = FakeDatetime, dt.date, dt.time, dt.timedelta, dt.timezone


tmp = pathlib.Path(tempfile.mkdtemp())
real_dt, real_sleep = noturno.dt, noturno.time.sleep
try:
    noturno.LOGS = tmp
    (tmp / 'noturno').mkdir()
    noturno.dt = FakeDt
    noturno.time.sleep = lambda s: None
    noturno.night_slot = lambda: []
    FakeDatetime.fixed = dt.datetime(2026, 11, 6, 19, 7)  # minuto :07, dentro de :05–:12
    folder = tmp / 'noturno' / f'{dt.date.today():%Y%m%d}-legado-passo2'

    def run_passo2(stop_answer, limit=None):
        calls = []

        def remote(args, name, out, timeout=0):
            calls.append(' '.join(args[:2]))
            if args[1] == 'status':
                return 0, {'pythonService': {'active': 'active', 'enabled': 'enabled', 'listening': True}}, ''
            return 0, stop_answer, ''
        noturno.remote = remote
        if limit is None:
            os.environ.pop(janela_testes.LIMIT_ENV, None)
        else:
            os.environ[janela_testes.LIMIT_ENV] = limit.isoformat()
        noturno.legado_passo2()
        return calls, json.loads((folder / 'resumo.json').read_text(encoding='utf-8'))

    calls, s = run_passo2({'ok': True}, limit=dt.datetime.now(TZ) - dt.timedelta(minutes=1))
    case('passo 2 com prazo vencido: nada é chamado', not calls and 'prazo da noite' in (s.get('stopped') or ''), str(s))
    calls, s = run_passo2({'ok': True, 'changed': True})
    case('passo 2 na janela: status, parar-python, status', calls == ['ops/54_legado.py status', 'ops/54_legado.py parar-python',
                                                                     'ops/54_legado.py status'] and not s.get('stopped')
         and 'desfazer-parar-python' in s['rollback'], str(calls) + ' ' + str(s.get('stopped')))
    calls, s = run_passo2({'ok': False, 'changed': False, 'reason': 'portão do passo 2 não passou: nada mudou'})
    case('passo 2 com portão fechado: registra o motivo', 'portão do passo 2' in (s.get('stopped') or ''), str(s.get('stopped')))
finally:
    noturno.dt, noturno.time.sleep = real_dt, real_sleep
    os.environ.pop(janela_testes.LIMIT_ENV, None)
    shutil.rmtree(tmp, ignore_errors=True)

print(f"{sum(ok for _, ok in results)}/{len(results)} casos")
sys.exit(0 if all(ok for _, ok in results) else 1)
