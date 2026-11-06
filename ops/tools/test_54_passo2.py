"""Passo 2 do legado (54_legado.py parar-python / desfazer-parar-python / portao-python) e a conversão de fuso do
gravacoes, com o servidor SIMULADO (systemctl, ss, journalctl, grep e mariadb falsos; nada sai desta máquina).
Uso: python test_54_passo2.py <worktree>"""
import datetime as dt
import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('legado', ROOT / 'ops' / '54_legado.py')
legado = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legado)

SERVICE = legado.PYTHON_SERVICE
results = []


def case(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('OK   ' if cond else 'FALHA') + ' ' + name + (('  → ' + detail) if detail and not cond else ''))


class P:
    def __init__(self, stdout='', returncode=0):
        self.stdout, self.returncode, self.stderr = stdout, returncode, ''


class Server:
    def __init__(self, day=(), kept=(), connections=(), nginx=(), code=(), offset='0', rows=''):
        self.state = {'active': 'active', 'enabled': 'enabled', 'listening': True}
        self.day, self.kept = list(day), list(kept) or list(day)
        self.connections, self.nginx, self.code = list(connections), list(nginx), list(code)
        self.offset, self.rows = offset, rows
        self.calls, self.where = [], None

    def run(self, cmd, timeout=600, check=True, **kw):
        self.calls.append(' '.join(cmd))
        if cmd[:2] == ['systemctl', 'is-active']:
            return P(self.state['active'])
        if cmd[:2] == ['systemctl', 'is-enabled']:
            return P(self.state['enabled'])
        if cmd[:2] == ['systemctl', 'stop']:
            self.state.update(active='inactive', listening=False)
            return P()
        if cmd[:2] == ['systemctl', 'disable']:
            self.state['enabled'] = 'disabled'
            return P()
        if cmd[:3] == ['systemctl', 'enable', '--now']:
            self.state.update(active='active', enabled='enabled', listening=True)
            return P()
        if cmd[:2] == ['ss', '-Hltn']:
            return P('LISTEN 0 2048 127.0.0.1:8001 0.0.0.0:*' if self.state['listening'] else '')
        if cmd[:2] == ['ss', '-Htn']:
            return P('\n'.join(self.connections))
        if cmd[0] == 'journalctl':
            lines = self.day if '--since' in cmd else self.kept
            return P('\n'.join(lines) if lines else '-- No entries --')
        if cmd[0] == 'sh':
            return P('2026-10-30T07:10:01-0300 srv kernel: ...')
        if cmd[:2] == ['grep', '-rlE']:
            return P('\n'.join(self.nginx), 0 if self.nginx else 1)
        if cmd[:2] == ['grep', '-rIlE']:
            return P('\n'.join(self.code), 0 if self.code else 1)
        if cmd[0] == 'mariadb' and 'timestampdiff' in cmd[-1]:
            return P(self.offset)
        if cmd[0] == 'mariadb' and 'update_time' in cmd[-1]:
            self.where = cmd[-1]
            return P(self.rows)
        if cmd[0] == 'mariadb' and 'processlist' in cmd[-1]:
            return P('')
        raise AssertionError('chamada inesperada: ' + ' '.join(cmd))


tmp = pathlib.Path(tempfile.mkdtemp())
cron_ok = (f'BIOMIE_PHP_BIN=/usr/bin/php\n{legado.STEP1_MARKER}*/30 * * * * www-data php materialize.php\n'
           f'{legado.MARKER}0 3 * * * root /var/www/biomie/live/cron/hostinger/db_backup.sh\n')
capacity_ok = f'{legado.STEP1_MARKER}*/5 * * * * root /usr/local/bin/capacity.sh\n'


def install(server, cron=cron_ok, capacity=capacity_ok):
    legado.run = server.run
    legado.subprocess = type('S', (), {'run': staticmethod(lambda *a, **k: None)})
    (tmp / 'biomie').write_text(cron)
    (tmp / 'biomie-capacity').write_text(capacity)
    legado.LEGACY_CRON, legado.CAPACITY_CRON = tmp / 'biomie', tmp / 'biomie-capacity'
    legado.ARCHIVE_DIR = tmp / 'legado'


try:
    # 1. Todos os portões abertos → para e tira do boot, com registro.
    s = Server(); install(s)
    out = legado.stop_python()
    record = pathlib.Path(out.get('record') or tmp / 'x')
    case('portões abertos: para, tira do boot e grava o registro',
         out['ok'] and out['changed'] and s.state == {'active': 'inactive', 'enabled': 'disabled', 'listening': False}
         and record.exists() and json.loads(record.read_text())['after']['enabled'] == 'disabled', json.dumps(out)[:300])
    case('evidências: "-- No entries --" não conta como linha', out['evidence']['journalLines24h'] == 0
         and out['evidence']['requests24h'] == 0, str(out['evidence']))

    # 2. Cada portão fechado → nada muda.
    uvicorn = 'INFO:     127.0.0.1:51234 - "GET /health HTTP/1.1" 200 OK'
    for label, server, kw, gate in (
            ('requisição nas 24 h', Server(day=[uvicorn]), {}, 'noRequests24h'),
            ('conexão aberta na 8001', Server(connections=['ESTAB 0 0 127.0.0.1:8001 127.0.0.1:40000']), {}, 'noConnections'),
            ('rota do nginx para a 8001', Server(nginx=['/etc/nginx/sites-enabled/biomie-local']), {}, 'noNginxRoute'),
            ('código do legado chamando a 8001', Server(code=['/var/www/biomie/live/app/api.php']), {}, 'noLegacyCodeCaller'),
            ('passo 1 não feito (tarefa ativa)', Server(), {'cron': '*/30 * * * * www-data php materialize.php\n'}, 'step1Done'),
            ('passo 1 não feito (capacity ativo)', Server(), {'capacity': '*/5 * * * * root /usr/local/bin/capacity.sh\n'},
             'step1Done')):
        install(server, **kw)
        out = legado.stop_python()
        case(f'{label}: portão fecha e nada muda', not out['ok'] and not out['changed'] and out['failedGates'] == [gate]
             and not any(c.startswith(('systemctl stop', 'systemctl disable')) for c in server.calls)
             and server.state['active'] == 'active', json.dumps(out.get('failedGates')))

    # 3. Linha de log sem requisição (ex.: aviso de início) não fecha o portão; requisição antiga (fora das 24 h) só
    #    aparece nas evidências.
    s = Server(day=['INFO:     Started server process [123]'], kept=['INFO:     Started server process [123]', uvicorn])
    install(s)
    out = legado.python_gate_status()
    case('linha sem requisição não fecha; requisição antiga só nas evidências', out['wouldStop']
         and out['evidence']['requestsInJournal'] == 1 and out['evidence']['journalLines24h'] == 1, json.dumps(out)[:300])
    case('portao-python não muda nada', not any(c.startswith(('systemctl stop', 'systemctl disable', 'systemctl enable'))
                                                for c in s.calls), str(s.calls))

    # 4. Desfazer.
    s = Server(); install(s)
    legado.stop_python()
    out = legado.undo_stop_python()
    case('desfazer: religa e volta ao boot', out['ok'] and s.state == {'active': 'active', 'enabled': 'enabled', 'listening': True},
         json.dumps(out))

    # 5. gravacoes: hora do servidor convertida para o relógio do MariaDB.
    since = '2026-11-04T18:36:25'
    utc = dt.datetime.fromisoformat(since).astimezone().astimezone(dt.timezone.utc).replace(tzinfo=None)
    for offset, label in (('0', 'MariaDB em UTC'), ('-10800', 'MariaDB no fuso −03')):
        s = Server(offset=offset, rows='webhook_inbox\t2026-11-05 03:35:12\n'); install(s)
        out = legado.writes_since(since)
        want = (utc + dt.timedelta(seconds=int(offset))).strftime('%Y-%m-%d %H:%M:%S')
        case(f'gravacoes ({label}): compara com {want}', out['sinceDb'] == want and f"update_time > '{want}'" in (s.where or '')
             and out['tables'] == 1, f"{out['sinceDb']} {s.where}")
    s = Server(offset='erro'); install(s)
    try:
        legado.writes_since(since)
        case('relógio do MariaDB ilegível: recusa', False, 'aceitou')
    except SystemExit as e:
        case('relógio do MariaDB ilegível: recusa', 'relógio' in str(e), str(e))
    s = Server(); install(s)
    out = legado.writes_since(None)
    case('gravacoes sem data: lista tudo, sem conversão', out['sinceDb'] is None and "update_time >" not in (s.where or ''),
         str(s.where))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(f"{sum(ok for _, ok in results)}/{len(results)} casos")
sys.exit(0 if all(ok for _, ok in results) else 1)
