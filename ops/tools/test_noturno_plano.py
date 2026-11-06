"""Fluxo de decisões de noturno.plano / ativar_plano com o servidor SIMULADO (nada sai desta máquina).
Uso: python test_noturno_plano.py <worktree>"""
import datetime as real_dt
import json
import pathlib
import shutil
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'ops'))
import noturno  # noqa: E402

REL, PREV = '8d68dc874246', '2154e450a071'


class FakeDatetime(real_dt.datetime):
    fixed = None

    @classmethod
    def now(cls, tz=None):
        return cls.fixed or real_dt.datetime.now()


class FakeDt:
    datetime = FakeDatetime
    date = real_dt.date
    time = real_dt.time
    timedelta = real_dt.timedelta


noturno.dt = FakeDt
noturno.time.sleep = lambda s: None


class World:
    def __init__(self, prod=PREV, activation_rc=0, rollback_rc=0, smokes=None, night=True, check_ok=True, fat='skipped',
                 undo='skipped', photos=None, up_fail=False, refresh_fail=False, raise_at=None):
        self.prod, self.activation_rc, self.rollback_rc = prod, activation_rc, rollback_rc
        self.fat, self.undo, self.photos = fat, undo, photos or {}
        self.up_fail, self.refresh_fail, self.raise_at = up_fail, refresh_fail, raise_at
        self.smokes = smokes or {}
        self.calls, self.smoke_calls, self.pause_reason = [], [], None
        self.check_ok = check_ok
        noturno.plano_night_ok = lambda now=None: night

    def remote(self, args, name, outdir, timeout=0):
        self.calls.append(' '.join(args))
        script = args[0].split('/')[-1]
        if self.raise_at and script == self.raise_at:
            raise RuntimeError('simulado: ' + script)
        if script == '22_test_database.py':
            return 0, {'all_ok': True, 'migrations_applied': 51, 'suites': {}}, ''
        if script == '41_homolog.py':
            if args[1] == 'db-refresh' and self.refresh_fail:
                return 1, None, 'cópia falhou'
            if args[1] == 'up' and args[2] == REL and self.up_fail:
                return 1, None, 'subida falhou'
            if args[1] == 'up':
                return 0, {'migrations': '51 / 0050', 'login_page': 200, 'seconds': 90, 'image': 'i'}, ''
            return 0, {'ok': True}, ''
        if script == '56_plano_voo_check.py':
            return 0, {'ok': self.check_ok, 'problems': [] if self.check_ok else ['x']}, ''
        if script == '58_desfazer_0051.py':
            if self.undo == 'skipped':
                return 0, {'database': args[3][5:], 'ok': True, 'skipped': 'a 0051 não está neste banco'}, ''
            if self.undo == 'desfeita':
                return 0, {'database': args[3][5:], 'ok': True, 'desfeita': True}, ''
            return 1, {'database': args[3][5:], 'ok': False, 'error': 'psql caiu'}, 'psql caiu'
        if script == '57_faturamento_check.py':
            if self.fat == 'skipped':
                return 0, {'database': 'biomie_v2_hml', 'skipped': 'a 0051 não está aplicada nesta cópia', 'ok': None}, ''
            if self.fat == 'ok':
                return 0, {'database': 'biomie_v2_hml', 'ok': True, 'problems': []}, ''
            if self.fat == 'diferente':
                return 0, {'database': 'biomie_v2_hml', 'ok': False, 'problems': ['super mag-filial ano: linhas 1×2']}, ''
            return 1, None, 'psql caiu'
        if script == '51_ui_release_guard.py':
            return 0, {'preserves_ui': True, 'active': self.prod}, ''
        if script == '25_load.py':
            if args[1] == 'pause':
                self.pause_reason = args[2]
            if args[1] == 'resume':
                self.pause_reason = None
            return 0, {'worker': {'state': 'PAUSED' if self.pause_reason else 'IDLE', 'reason': self.pause_reason}}, ''
        if script == '21_activate_release.py':
            target = args[1]
            rc = self.activation_rc if target == REL else self.rollback_rc
            if rc == 0:
                self.prod = target
            return rc, ({'ok': True} if rc == 0 else None), ('' if rc == 0 else 'falhou')
        raise AssertionError('chamada inesperada: ' + ' '.join(args))

    BASE_PHOTO = {'parte': {'n': 1}, 'sales': {'m': 1}, 'kpis': {'k': 1}}

    def photo(self, out, name, copy=False):
        return self.photos.get(name, self.BASE_PHOTO)

    def smoke(self, args, name, out):
        self.smoke_calls.append(name)
        seq = self.smokes.get(name)
        ok = seq if seq is not None else True
        return {'ok': ok, 'failed': [] if ok else [{'name': 'x'}], 'problems': None, 'error': None}


def install(w, browser=None):
    noturno.browser_problem = lambda: browser  # pré-teste do navegador (06/11): sem abrir um Chromium de verdade
    noturno.remote = w.remote
    noturno.smoke = w.smoke
    noturno.production_release = lambda out: w.prod
    noturno.worker_state = lambda out, name: w.remote(['ops/25_load.py', 'status'], name, out)[1]['worker']
    noturno.photo = w.photo
    noturno.activation_slot = lambda: []


def read(folder):
    return json.loads((noturno.LOGS / 'noturno' / folder / 'resumo.json').read_text(encoding='utf-8'))


results = []


def case(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('OK   ' if cond else 'FALHA') + ' ' + name + (('  → ' + detail) if detail and not cond else ''))


tmp = pathlib.Path(tempfile.mkdtemp())
noturno.LOGS = tmp
(tmp / 'noturno').mkdir()
today = f'{real_dt.date.today():%Y%m%d}'
try:
    # H. Homologação chegando de dia (dia útil) → não faz nada.
    w = World(); install(w)
    FakeDatetime.fixed = real_dt.datetime(2026, 11, 5, 10, 0)
    noturno.plano(REL)
    s = read(f'{today}-plano-de-voo')
    case('homologação de dia útil não roda', 'fora da noite' in (s.get('stopped') or '') and not w.calls, str(s))

    # H2. Navegador local que não abre (05/11: 1h40 de cópia à toa) → para antes das suítes, nada feito.
    w = World(); install(w, browser="Error: Cannot find module 'playwright'")
    FakeDatetime.fixed = real_dt.datetime(2026, 11, 4, 21, 0)
    noturno.plano(REL)
    s = read(f'{today}-plano-de-voo')
    case('navegador que não abre: para antes de tudo', 'navegador local não abre' in (s.get('stopped') or '') and not w.calls,
         str(s.get('stopped')) + ' ' + str(w.calls))

    # I. Homologação completa à noite → validação ok.
    w = World(); install(w)
    FakeDatetime.fixed = real_dt.datetime(2026, 11, 4, 21, 0)
    noturno.plano(REL)
    s = read(f'{today}-plano-de-voo')
    ok, why = noturno.plano_validation_ok(REL)
    case('homologação completa passa', ok and not s.get('stopped') and 'stock' in s, json.dumps(why))
    case('homologação testa o estoque e o retorno', {'05b-navegador-estoque', '07-retorno-navegador-regressao'} <= set(w.smoke_calls), str(w.smoke_calls))

    # G. Navegador falha uma vez e passa na 2ª → ok, 1ª registrada.
    w = World(smokes={'04-navegador-plano-de-voo': False}); install(w)
    noturno.plano(REL)
    s = read(f'{today}-plano-de-voo')
    case('nova tentativa do navegador', s['browser']['ok'] and s['browser'].get('firstAttempt', {}).get('ok') is False, str(s['browser']))

    # J. Estoque falha nas duas → validação recusa.
    w = World(smokes={'05b-navegador-estoque': False, '05b-navegador-estoque-2': False}); install(w)
    noturno.plano(REL)
    ok, why = noturno.plano_validation_ok(REL)
    case('estoque falhando barra a ativação', not ok and 'navegador: stock' in why, json.dumps(why))

    # K–N. Conferência 57 (faturamento 0051): skipped e ok passam; diferença ou erro barram.
    for fat, want_ok, label in (('skipped', True, 'release sem 0051 (57 skipped) passa'),
                                ('ok', True, 'faturamento igual (57 ok) passa'),
                                ('diferente', False, 'faturamento diferente (57) barra a ativação'),
                                ('erro', False, 'conferência 57 com erro barra a ativação')):
        w = World(fat=fat); install(w)
        noturno.plano(REL)
        ok, why = noturno.plano_validation_ok(REL)
        s = read(f'{today}-plano-de-voo')
        ran = any(c.startswith('ops/57_faturamento_check.py') for c in w.calls)
        case(label, ran and ok == want_ok and (want_ok or any('conferência 57' in x for x in why)), json.dumps(why))

    # O–Q. Retorno da 0051 (58) no teste de retorno da homologação; foto da cópia sem o faturamento.
    w = World(fat='ok', undo='desfeita'); install(w)
    noturno.plano(REL)
    ok, why = noturno.plano_validation_ok(REL)
    i58 = next((i for i, c in enumerate(w.calls) if c.startswith('ops/58_desfazer_0051.py')), None)
    iup = next((i for i, c in enumerate(w.calls) if c.startswith('ops/41_homolog.py up ' + w.prod)), None)
    case('homologação: 58 na cópia antes da release anterior subir', ok and i58 is not None and iup is not None and i58 < iup
         and '--db=biomie_v2_hml' in w.calls[i58], json.dumps(why) + ' ' + str(w.calls))
    w = World(fat='ok', undo='erro'); install(w)
    noturno.plano(REL)
    ok, why = noturno.plano_validation_ok(REL)
    case('homologação: 58 com erro barra a ativação', not ok and any('retorno da 0051' in x for x in why), json.dumps(why))
    w = World(fat='ok', photos={'02d-foto-da-copia-depois': {'parte': {'n': 1}, 'sales': {'error': 'timeout'}, 'kpis': {'k': 1}}}); install(w)
    noturno.plano(REL)
    ok, why = noturno.plano_validation_ok(REL)
    case('homologação com 0051: foto sem o faturamento barra', not ok and any('partes do faturamento' in x for x in why), json.dumps(why))

    # W–Z. Saída antecipada ou exceção depois de mexer na cópia → a cópia é desligada antes de registrar
    # (o portão do MAG AI para se houver biomie-hml rodando).
    for kw, label in (({'up_fail': True}, 'subida falhou: cópia desligada'),
                      ({'refresh_fail': True}, 'cópia nova falhou: cópia desligada')):
        w = World(**kw); install(w)
        noturno.plano(REL)
        s = read(f'{today}-plano-de-voo')
        case(label, bool(s.get('stopped')) and w.calls[-1] == 'ops/41_homolog.py down'
             and (s.get('down') or {}).get('early') is True, str(s.get('stopped')) + ' ' + str(w.calls[-2:]))
    w = World(raise_at='56_plano_voo_check.py'); install(w)
    try:
        noturno.plano(REL)
        raised = False
    except RuntimeError:
        raised = True
    s = read(f'{today}-plano-de-voo')
    case('exceção no meio: cópia desligada e registrada', raised and w.calls[-1] == 'ops/41_homolog.py down'
         and 'exceção' in (s.get('stopped') or '') and (s.get('down') or {}).get('early') is True,
         str(s.get('stopped')) + ' ' + str(w.calls[-2:]))
    ok, why = noturno.plano_validation_ok(REL)
    case('exceção no meio barra a ativação', not ok and any('parou' in x for x in why), json.dumps(why))

    # Volta a homologação boa para os casos de ativação.
    w = World(); install(w)
    noturno.plano(REL)

    # B. Produção em outra release → nada muda.
    w = World(prod='cdb333a1f2a5'); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('release anterior errada: nada muda', 'não a 2154e450a071' in (s.get('stopped') or '') and not any('21_activate' in c for c in w.calls), str(s.get('stopped')))

    # C. Fora da madrugada → nada muda.
    w = World(night=False); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('fora da madrugada: nada muda', 'fora da madrugada' in (s.get('stopped') or '') and not any('21_activate' in c or '25_load.py pause' in c for c in w.calls), str(s.get('stopped')))

    # D. Sucesso.
    w = World(); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('ativação com sucesso', not s.get('stopped') and s['active'] == REL and w.prod == REL and w.pause_reason is None
         and s['photo'].get('equal') and s['browser']['ok'] and 'autoRollback' not in s, json.dumps(s)[:400])

    # E. Ativação falha → volta sozinha, worker retomado.
    w = World(activation_rc=1); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('ativação falhou: voltou para a anterior', 'voltou sozinha' in (s.get('stopped') or '') and w.prod == PREV and w.pause_reason is None, str(s.get('stopped')))

    # F. Ativação ok, navegador do Plano falha 2x na produção → retorno automático.
    w = World(smokes={'03-navegador-plano-producao': False, '03-navegador-plano-producao-2': False}); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('navegador falhou na produção: retorno automático', 'voltou sozinha' in (s.get('stopped') or '') and w.prod == PREV
         and s['autoRollback']['ok'] and w.pause_reason is None, json.dumps(s.get('autoRollback'))[:300])

    # F2. Navegador falha e o retorno também falha → ATENÇÃO.
    w = World(smokes={'04-navegador-regressao-producao': False, '04-navegador-regressao-producao-2': False}, rollback_rc=1); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('retorno automático que falha vira ATENÇÃO', (s.get('stopped') or '').startswith('ATENÇÃO') and not s['autoRollback']['ok'], str(s.get('stopped')))

    # G2. Navegador da produção falha 1x e passa → sem retorno.
    w = World(smokes={'03-navegador-plano-producao': False}); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('produção: 2ª tentativa passa, sem retorno', not s.get('stopped') and w.prod == REL and 'autoRollback' not in s, str(s.get('stopped')))

    # R–V. Foto e 0051 na ativação.
    def order(w, a, b):
        ia = next((i for i, c in enumerate(w.calls) if c.startswith(a)), None)
        ib = next((i for i, c in enumerate(w.calls) if c.startswith(b)), None)
        return ia is not None and ib is not None and ia < ib
    w = World(undo='desfeita', photos={'01a-foto-depois': {'parte': {'n': 2}, 'sales': {'m': 1}, 'kpis': {'k': 1}}}); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('foto diferente: volta sozinha, 58 antes da anterior', 'foto' in (s.get('stopped') or '') and 'voltou sozinha' in s['stopped']
         and w.prod == PREV and w.pause_reason is None and order(w, 'ops/58_desfazer_0051.py', 'ops/21_activate_release.py ' + PREV)
         and s['autoRollback']['undo0051']['ok'], str(s.get('stopped')) + ' ' + str(w.calls))
    w = World(photos={'01a-foto-depois': {'parte': {'n': 1}, 'sales': {'error': 'timeout'}, 'kpis': {'k': 1}}}); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('foto sem o faturamento: volta sozinha', 'foto' in (s.get('stopped') or '') and w.prod == PREV, str(s.get('stopped')))
    w = World(activation_rc=1, undo='desfeita'); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('ativação falhou: 58 antes da anterior', w.prod == PREV and order(w, 'ops/58_desfazer_0051.py', 'ops/21_activate_release.py ' + PREV)
         and s['rollbackUndo0051']['ok'], str(w.calls))
    w = World(undo='desfeita', smokes={'03-navegador-plano-producao': False, '03-navegador-plano-producao-2': False}); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('navegador falhou: 58 antes da anterior', s['autoRollback']['ok'] and w.prod == PREV
         and order(w, 'ops/58_desfazer_0051.py', 'ops/21_activate_release.py ' + PREV), str(w.calls))
    w = World(undo='erro', smokes={'03-navegador-plano-producao': False, '03-navegador-plano-producao-2': False}); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('58 falhou no retorno: release volta, mas vira ATENÇÃO', w.prod == PREV and not s['autoRollback']['ok']
         and (s.get('stopped') or '').startswith('ATENÇÃO'), str(s.get('stopped')))

    # K. Já ativa → nada.
    w = World(prod=REL); install(w)
    noturno.ativar_plano(REL, expected_previous=PREV)
    s = read(f'{today}-ativacao-plano-{REL}')
    case('já ativa: nada a fazer', 'já está ativa' in (s.get('stopped') or ''), str(s.get('stopped')))

    # L. plano_night_ok de verdade.
    import importlib
    real = importlib.reload(noturno)
    t = lambda h, m: real.plano_night_ok(real_dt.datetime(2026, 11, 5, h, m))  # noqa: E731
    case('madrugada: 18:30 sim, 05:29 sim, 05:30 não, 12:00 não', t(18, 30) and t(5, 29) and not t(5, 30) and not t(12, 0))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(f"{sum(ok for _, ok in results)}/{len(results)} casos")
sys.exit(0 if all(ok for _, ok in results) else 1)
