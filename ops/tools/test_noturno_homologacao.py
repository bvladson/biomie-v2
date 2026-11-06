"""Saídas de noturno.intel / matriz_teste / trem / intel_diaria_copia com o servidor SIMULADO (nada sai desta
máquina). Depois de mexer na cópia, toda saída (normal, antecipada ou por exceção) termina com a homologação
desligada: a fila seguinte e o portão do MAG AI (para se houver biomie-hml rodando) contam com isso.
Uso: python test_noturno_homologacao.py <worktree>"""
import datetime as real_dt
import json
import pathlib
import shutil
import subprocess as real_subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'ops'))
import noturno  # noqa: E402

REL, PROD = 'aaaaaaaaaaaa', 'f4bbe45540f9'
DOWN = 'ops/41_homolog.py down'
noturno.time.sleep = lambda s: None


class Proc:
    def __init__(self, ok=True):
        browser = {'ok': ok, 'steps': [{'name': 'tela', 'ok': ok}], 'problems': []}
        self.returncode = 0 if ok else 1
        self.stdout = json.dumps({'browser': browser, 'browser_exit': 0 if ok else 1,
                                  'cleanup': [{'remaining_smoke_users': 0}]})
        self.stderr = ''


class World:
    """fail: passos que falham sem exceção ('tests', 'refresh', 'up', 'engine', 'runner');
    raise_at: chamada que levanta TimeoutExpired ('41_homolog.py intel-run', '29_smoke.py', 'smoke', ...);
    down_raises: o próprio down levanta (tempo esgotado)."""

    def __init__(self, fail=(), raise_at=None, down_raises=False):
        self.fail, self.raise_at, self.down_raises = set(fail), raise_at, down_raises
        self.calls = []

    def boom(self, what):
        raise real_subprocess.TimeoutExpired(cmd=what, timeout=1)

    def remote(self, args, name, outdir, timeout=0):
        self.calls.append(' '.join(args))
        script = args[0].split('/')[-1]
        sub = args[1] if len(args) > 1 else ''
        if self.raise_at in (script, f'{script} {sub}', f"{script} {sub} {args[2] if len(args) > 2 else ''}"):
            self.boom(script)
        if script == '22_test_database.py':
            ok = 'tests' not in self.fail
            return (0 if ok else 1), {'all_ok': ok, 'migrations_applied': 51, 'suites': {}}, ''
        if script == '41_homolog.py':
            if sub == 'down':
                if self.down_raises:
                    self.boom('down')
                return 0, {'ok': True}, ''
            if sub == 'db-refresh':
                return (1, None, 'cópia falhou') if 'refresh' in self.fail else (0, {'ok': True}, '')
            if sub == 'up':
                if args[2] == REL and 'up' in self.fail:
                    return 1, None, 'subida falhou'
                return 0, {'migrations': '51 / 0051', 'login_page': 200, 'seconds': 60, 'image': 'i'}, ''
            if sub == 'suppliers-load':
                return 0, {'complete': True, 'notLoaded': [], 'companies': {}, 'after': {}, 'exit': 0}, ''
            if sub == 'intel-run':
                if 'engine' in self.fail:
                    return 0, {'exit': 1, 'stdout': ''}, ''
                return 0, {'exit': 0, 'stdout': '{"event": "intel_published"}', 'buildSeconds': 1, 'runSeconds': 2}, ''
            if sub == 'tx-probe':
                return 0, {'startedUtc': 'x', 'seconds': 40, 'aborted': None, 'result': 'ok', 'calls': 4, 'retries': 0,
                           'byMethod': {'ListarContasReceber': {
                               'calls': 4, 'outcomes': {'ok': 4}, 'records': 0, 'seconds': 40,
                               'emptyThenWaited12s': 3, 'gapAfterEmpty': [], 'gapAfterOk': []}},
                           'finance': {'copy': 1, 'production': 1}, 'productionWorker': {}}, ''
        if script == '44_omie_ritmo.py':
            return 0, {'busyAnswers': {'total': 0, 'byCall': {}}, 'circuitPauseLines': {'total': 0}, 'runs': []}, ''
        if script in ('40_stock.py', '47_hml_replenishment_seed.py', '48_hml_vs_prod.py'):
            return 0, {'ok': True}, ''
        if script == '43_intel_check.py':
            return 0, {'allOk': True, 'phasesOk': True}, ''
        if script == '53_intel_diaria_teste.py':
            return 0, {'allOk': True, 'runnerSha256': 'abc'}, ''
        raise AssertionError('chamada inesperada: ' + ' '.join(args))

    def smoke(self, args, name, out):
        self.calls.append('smoke ' + name)
        if self.raise_at == 'smoke':
            self.boom('smoke')
        return {'ok': True, 'failed': [], 'problems': None, 'error': None}

    def run(self, cmd, **kw):  # o navegador do intel() é chamado direto pelo subprocess
        self.calls.append('29_smoke.py')
        if self.raise_at == '29_smoke.py':
            self.boom('29_smoke.py')
        return Proc(True)


class FakeSubprocess:
    TimeoutExpired = real_subprocess.TimeoutExpired

    def __init__(self, world):
        self.run = world.run


def install(w):
    noturno.remote = w.remote
    noturno.smoke = w.smoke
    noturno.subprocess = FakeSubprocess(w)
    noturno.production_release = lambda out: PROD
    noturno.photo = lambda out, name, copy=False: {'parte': {'n': 1}, 'sales': {'m': 1}, 'kpis': {'k': 1}}
    noturno.upload_runner = lambda out, name: {'ok': 'runner' not in w.fail, 'local': 'abc'}


def read(folder):
    return json.loads((noturno.LOGS / 'noturno' / folder / 'resumo.json').read_text(encoding='utf-8'))


results = []


def case(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('OK   ' if cond else 'FALHA') + ' ' + name + (('  → ' + detail) if detail and not cond else ''))


def run(fn, *args):
    """Roda o fluxo; devolve True se levantou exceção (a exceção do passo tem de ser repassada)."""
    try:
        fn(*args)
        return False
    except real_subprocess.TimeoutExpired:
        return True


def ends_down(w):
    return bool(w.calls) and w.calls[-1] == DOWN


tmp = pathlib.Path(tempfile.mkdtemp())
noturno.LOGS = tmp
(tmp / 'noturno').mkdir()
today = f'{real_dt.date.today():%Y%m%d}'
try:
    for suppliers in (True, False):
        tag = 'intel-fornecedores' if suppliers else 'intel'
        folder = f'{today}-inteligencia' + ('-fornecedores' if suppliers else '')

        w = World(); install(w)
        raised = run(noturno.intel, REL, suppliers)
        s = read(folder)
        case(f'{tag}: completa termina desligada', not raised and not s.get('stopped') and ends_down(w)
             and s.get('down') == {'rc': 0}, str(w.calls[-2:]) + ' ' + str(s.get('down')))
        if suppliers:
            ok, why = noturno.validation_ok(REL)
            case(f'{tag}: completa passa na validação', ok, json.dumps(why))

        w = World(fail={'tests'}); install(w)
        run(noturno.intel, REL, suppliers)
        s = read(folder)
        case(f'{tag}: suítes falhando não mexem na cópia', 'suítes' in (s.get('stopped') or '')
             and not any(c.startswith('ops/41_homolog.py') for c in w.calls), str(w.calls))

        for fail, word in (('refresh', 'cópia nova'), ('up', 'não subiu'), ('engine', 'motor')):
            w = World(fail={fail}); install(w)
            raised = run(noturno.intel, REL, suppliers)
            s = read(folder)
            case(f'{tag}: {fail} falhou → cópia desligada antes de registrar', not raised and word in (s.get('stopped') or '')
                 and ends_down(w) and (s.get('down') or {}).get('early') is True, str(s.get('stopped')) + ' ' + str(w.calls[-2:]))

        steps = ['41_homolog.py db-refresh', '41_homolog.py intel-run', '43_intel_check.py', '29_smoke.py']
        if suppliers:
            steps += ['41_homolog.py suppliers-load', f'41_homolog.py up {PROD}', 'smoke']
        for step in steps:
            w = World(raise_at=step); install(w)
            raised = run(noturno.intel, REL, suppliers)
            s = read(folder)
            case(f'{tag}: exceção em {step} → desligada, registrada e repassada', raised and ends_down(w)
                 and 'exceção' in (s.get('stopped') or '') and (s.get('down') or {}).get('early') is True,
                 str(s.get('stopped')) + ' ' + str(w.calls[-2:]))
        if suppliers:
            ok, why = noturno.validation_ok(REL)
            case(f'{tag}: exceção barra a ativação', not ok and any('parou' in x for x in why), json.dumps(why))

        w = World(down_raises=True); install(w)
        raised = run(noturno.intel, REL, suppliers)
        s = read(folder)
        case(f'{tag}: down que falha fica registrado', raised and 'error' in (s.get('down') or {})
             and 'exceção' in (s.get('stopped') or ''), str(s.get('down')))

    # matriz_teste: rodadas com a cópia no ar.
    w = World(); install(w)
    raised = run(noturno.matriz_teste, REL, 2)
    s = read(f'{today}-matriz-preparo')
    case('matriz-teste: completa termina desligada', not raised and ends_down(w)
         and sum(c.startswith('ops/41_homolog.py tx-probe') for c in w.calls) == 2
         and (s.get('down') or {}).get('early') is False, str(w.calls[-2:]) + ' ' + str(s.get('down')))
    w = World(raise_at='41_homolog.py tx-probe'); install(w)
    raised = run(noturno.matriz_teste, REL, 2)
    s = read(f'{today}-matriz-preparo')
    case('matriz-teste: exceção na rodada → desligada e repassada', raised and ends_down(w)
         and 'exceção' in (s.get('stopped') or '') and (s.get('down') or {}).get('early') is True, str(s))
    w = World(fail={'up'}); install(w)
    raised = run(noturno.matriz_teste, REL, 2)
    case('matriz-teste: subida falhou → sem rodadas, desligada', not raised and ends_down(w)
         and not any('tx-probe' in c for c in w.calls), str(w.calls))

    # trem.
    w = World(); install(w)
    raised = run(noturno.trem, REL)
    s = read(f'{today}-trem-{REL}')
    case('trem: completo termina desligado', not raised and ends_down(w) and not s.get('stopped'), str(w.calls[-2:]))
    w = World(raise_at='48_hml_vs_prod.py'); install(w)
    raised = run(noturno.trem, REL)
    s = read(f'{today}-trem-{REL}')
    case('trem: exceção → desligado, registrado e repassado', raised and ends_down(w)
         and 'exceção' in (s.get('stopped') or ''), str(s.get('stopped')))
    w = World(fail={'up'}); install(w)
    raised = run(noturno.trem, REL)
    case('trem: subida falhou → desligado', not raised and ends_down(w), str(w.calls[-2:]))

    # intel_diaria_copia.
    w = World(); install(w)
    raised = run(noturno.intel_diaria_copia, PROD)
    s = read(f'{today}-inteligencia-diaria-copia')
    case('análise diária na cópia: completa termina desligada', not raised and ends_down(w) and s.get('ok') is True,
         str(s.get('ok')) + ' ' + str(w.calls[-2:]))
    w = World(raise_at='53_intel_diaria_teste.py'); install(w)
    raised = run(noturno.intel_diaria_copia, PROD)
    s = read(f'{today}-inteligencia-diaria-copia')
    case('análise diária na cópia: exceção → desligada, ok falso', raised and ends_down(w) and s.get('ok') is False
         and 'exceção' in (s.get('stopped') or ''), str(s.get('stopped')))
    w = World(fail={'runner'}); install(w)
    raised = run(noturno.intel_diaria_copia, PROD)
    s = read(f'{today}-inteligencia-diaria-copia')
    case('análise diária na cópia: rotina não chegou → desligada', not raised and ends_down(w) and s.get('ok') is False,
         str(s.get('stopped')))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(f"{sum(ok for _, ok in results)}/{len(results)} casos")
sys.exit(0 if all(ok for _, ok in results) else 1)
