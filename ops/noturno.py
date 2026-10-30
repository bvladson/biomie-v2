"""Trabalhos noturnos da HOMOLOGAÇÃO, para o Agendador de Tarefas do Windows (não dependem de uma
sessão do Claude aberta). Cada passo pesado passa pela janela de testes (--esperar) e tudo fica em
ops/logs/noturno/<data>-<tarefa>/ (um arquivo por passo + resumo.json). Nada aqui muda a produção.

    python ops/noturno.py matriz [release] [rodadas]   # teste controlado da correção da MAG Matriz
    python ops/noturno.py sales-kpis [release]         # sales_kpis: diagnóstico, testes do banco e comparação
    python ops/noturno.py intel [release]              # Inteligência (fases 1–5) na homologação
    python ops/noturno.py intel-fornecedores [release] # idem, com fornecedores e prazos (0048/0049)
    python ops/noturno.py banco <release>              # só as suítes do banco da release (22), com a trava
    python ops/noturno.py ativar <release> [--importar-fornecedores]
                                                       # ATIVAÇÃO na produção (só com autorização do
                                                       # usuário): confere a validação do dia, espera
                                                       # minuto livre das cargas, ativa com cópia de
                                                       # segurança verificada, roda o motor uma vez,
                                                       # confere e testa no navegador
    python ops/noturno.py trem [release]               # versão combinada: suítes, cópia nova, subida,
                                                       # fornecedores, motor, conferências, comparação
                                                       # com a produção, navegador e RETORNO (a release da
                                                       # produção sobe sobre o mesmo banco e é testada)

Uma tarefa por vez e NA ORDEM em que começaram a esperar (fila de senhas em ops/logs/noturno/fila;
trava em ops/logs/noturno/.trava, solta sozinha quando o processo acaba, mesmo se cair). As tarefas que
mudam a cópia de banco começam com uma cópia nova da produção, então uma não depende da outra.

sales-kpis: 45 (diagnóstico do sales_kpis atual na cópia) → 22 (suítes do banco da release, num banco de
teste descartável) → 46 (atual × rápido nos dados reais da cópia, numa transação desfeita, mais o índice
candidato criado, medido e apagado). Release padrão: SALES_KPIS_RELEASE.

intel: 22 (suítes do banco da release) → 41_homolog up (migrações 0047/0048 na cópia, imagem e
subida) → Estoque liberado na cópia → prazo HIPOTÉTICO de 30 dias na cópia (47, rotulado como teste)
→ motor (41_homolog intel-run) → conferência (43) → navegador (29_smoke --intel --hml) → down.
Release padrão: INTEL_RELEASE.

intel-fornecedores: como intel, mas com cópia NOVA da produção antes (db-refresh: a cópia tem as migrações
antigas da fase 5) e, depois de subir, a importação dos fornecedores do Omie na cópia (41_homolog
suppliers-load: só LÊ ListarProdutoFornecedor, 10 por página) antes do prazo de teste (47) e do motor.

matriz (parecer de 26/10/2026): base da produção (72 h) → até N rodadas do tx-probe (cada uma espera
uma janela sem uso real da chave pela produção) → produção nas últimas horas. A série PARA na primeira
rodada encerrada por segurança ou com 2 ou mais respostas "já existe uma requisição".
"""
import datetime as dt
import json
import msvcrt
import os
import pathlib
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
BASE = pathlib.Path(__file__).resolve().parent.parent
# --teste: não espera a janela (no expediente a janela recusa na hora): confere só o encanamento.
WAIT = [] if '--teste' in sys.argv else ['--esperar']
LOGS = BASE / 'ops' / 'logs'
# sales_kpis rápido (migração 0046, branch perf/sales-kpis, commit fe85aca).
SALES_KPIS_RELEASE = 'fe85acab7ae6'
# Inteligência do Estoque fases 1–5 (branch feature/estoque-inteligencia, commit 885ff74).
INTEL_RELEASE = '885ff74576cd'
# Fornecedores e prazos (0048/0049) e o trem de integração; a tarefa do Agendador usa estes valores, então
# trocar a release aqui (commit) muda o que roda à noite sem registrar a tarefa de novo.
SUPPLIERS_RELEASE = '2bd5c7c701c4'
TRAIN_RELEASE = '266d297add0b'
# Release em produção (retorno do trem): sobe sobre o banco já migrado e precisa funcionar.
PRODUCTION_RELEASE = '1240466bf0c3'


def _held(path):
    """Senha de quem ainda está vivo: o dono mantém o arquivo travado; senha órfã (processo caiu) sai."""
    try:
        with open(path, 'a+') as h:
            h.seek(0)
            msvcrt.locking(h.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(h.fileno(), msvcrt.LK_UNLCK, 1)
        path.unlink(missing_ok=True)
        return False
    except OSError:
        return True


def night_lock(hours=6):
    """Trava exclusiva entre as tarefas noturnas, por ordem de chegada (o sistema solta quando o processo
    termina). Cada tarefa tira uma senha e só entra quando é a mais antiga ainda viva."""
    queue = LOGS / 'noturno' / 'fila'
    queue.mkdir(parents=True, exist_ok=True)
    ticket_path = queue / f'{time.time():017.6f}-{os.getpid()}.senha'
    ticket = open(ticket_path, 'a+')
    ticket.seek(0)
    msvcrt.locking(ticket.fileno(), msvcrt.LK_NBLCK, 1)
    path = LOGS / 'noturno' / '.trava'
    handle = open(path, 'a+')
    deadline = time.time() + hours * 3600
    while True:
        first = next((t for t in sorted(queue.glob('*.senha')) if t == ticket_path or _held(t)), None)
        if first == ticket_path:
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                ticket.seek(0)
                msvcrt.locking(ticket.fileno(), msvcrt.LK_UNLCK, 1)
                ticket.close()
                ticket_path.unlink(missing_ok=True)
                return handle
            except OSError:
                pass
        if time.time() > deadline:
            raise SystemExit('outra tarefa noturna ainda está rodando; desisti depois de esperar')
        time.sleep(30)


def remote(args, name, outdir, timeout=5 * 3600):
    """Roda um script de ops no servidor (remote.py) e lê a saída COMPLETA do log que ele grava."""
    before = set(LOGS.glob('*.log'))
    started = dt.datetime.now().isoformat(timespec='seconds')
    p = subprocess.run([sys.executable, str(BASE / 'ops' / 'remote.py')] + args, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout,
                       env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    new = sorted(set(LOGS.glob('*.log')) - before, key=lambda f: f.stat().st_mtime)
    full = new[-1].read_text(encoding='utf-8', errors='replace') if new else p.stdout
    (outdir / f'{name}.txt').write_text(f'# {started} rc={p.returncode}\n{full}\n--stderr--\n{p.stderr}',
                                        encoding='utf-8')
    try:
        data = json.loads(full[full.find('{'):full.rfind('}') + 1])
    except ValueError:
        data = None
    return p.returncode, data, p.stderr.strip()[-600:]


def matriz(release, rounds):
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-matriz'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'release': release, 'started': dt.datetime.now().isoformat(timespec='seconds'), 'runs': []}
    rc, base, err = remote(['ops/44_omie_ritmo.py', '72'], '00-base-producao-72h', out)
    summary['baseBefore'] = None if not base else {
        'busyAnswers': base['busyAnswers']['total'], 'busyByCall': base['busyAnswers']['byCall'],
        'circuitPauseLines': base['circuitPauseLines']['total'],
        'matriz': [r for r in base['runs'] if r['company'] == 'mag-matriz']}
    for i in range(1, rounds + 1):
        rc, data, err = remote(['ops/41_homolog.py', 'tx-probe', release, 'mag-matriz', 'receivables,settlements',
                                '62'] + WAIT, f'{i:02d}-tx-probe', out)
        if not data:
            summary['runs'].append({'run': i, 'rc': rc, 'error': err})
            summary['stopped'] = f'rodada {i} sem resultado (rc={rc})'
            break
        busy = sum(m['outcomes'].get('busy', 0) for m in data['byMethod'].values())
        summary['runs'].append({
            'run': i, 'startedUtc': data['startedUtc'], 'seconds': data['seconds'], 'aborted': data['aborted'],
            'result': data['result'], 'calls': data['calls'], 'busy': busy, 'retries': data['retries'],
            'byMethod': {k: {f: v[f] for f in ('calls', 'outcomes', 'records', 'seconds', 'emptyThenWaited12s',
                                                'gapAfterEmpty', 'gapAfterOk')}
                         for k, v in data['byMethod'].items()},
            'financeEqual': data['finance']['copy'] == data['finance']['production'],
            'finance': data['finance'], 'productionWorker': data['productionWorker']})
        if data['aborted'] or busy >= 2:
            summary['stopped'] = f"rodada {i}: {data['aborted'] or f'{busy} respostas busy'}"
            break
    rc, after, err = remote(['ops/44_omie_ritmo.py', '6'], '99-producao-6h', out)
    summary['productionLast6h'] = None if not after else {
        'busyAnswers': after['busyAnswers']['total'], 'circuitPauseLines': after['circuitPauseLines']['total']}
    summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


def sales_kpis(release):
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-sales-kpis'
    out.mkdir(parents=True, exist_ok=True)
    rc, data, err = remote(['ops/45_sales_kpis_diag.py', '--planos'] + WAIT, '01-diagnostico', out)
    summary = {'rc': rc, 'error': None if data else err,
               'warm_ms': {k: v['ms'][-1] for k, v in (data or {}).get('measures', {}).items()},
               'rows': {k: v['rows'] for k, v in (data or {}).get('measures', {}).items()},
               'plansFile': (data or {}).get('plans', {}).get('file')}
    if release:
        rc, tests, err = remote(['ops/22_test_database.py', release] + WAIT, '02-testes-do-banco', out)
        summary['dbTests'] = {
            'release': release, 'rc': rc, 'allOk': (tests or {}).get('all_ok'), 'error': None if tests else err,
            'suites': {k: ('pulada' if v.get('skipped') else v.get('ok')) for k, v in (tests or {}).get('suites', {}).items()},
            'salesKpisNotices': (tests or {}).get('suites', {}).get('deploy/db/verify_sales_kpis.sql', {}).get('notices'),
            'rollbackScripts': (tests or {}).get('rollback_scripts')}
        rc, cmp, err = remote(['ops/46_sales_kpis_compare.py', release, '--minutos=40'] + WAIT,
                              '03-comparacao-na-copia', out)
        summary['compare'] = cmp if cmp else {'rc': rc, 'error': err}
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


def intel(release, suppliers=False):
    out = LOGS / 'noturno' / (f'{dt.date.today():%Y%m%d}-inteligencia' + ('-fornecedores' if suppliers else ''))
    out.mkdir(parents=True, exist_ok=True)
    summary = {'release': release, 'started': dt.datetime.now().isoformat(timespec='seconds')}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    rc, tests, err = remote(['ops/22_test_database.py', release] + WAIT, '01-testes-do-banco', out)
    summary['dbTests'] = {'rc': rc, 'allOk': (tests or {}).get('all_ok'), 'error': None if tests else err,
                          'migrations': (tests or {}).get('migrations_applied'),
                          'suites': {k: ('pulada' if v.get('skipped') else v.get('ok'))
                                     for k, v in (tests or {}).get('suites', {}).items()},
                          'failures': {k: v.get('error') for k, v in (tests or {}).get('suites', {}).items()
                                       if not v.get('ok')}}
    if not (tests or {}).get('all_ok'):
        return done('suítes do banco não passaram: a homologação não sobe com teste falhando')
    remote(['ops/41_homolog.py', 'down'], '02a-homologacao-down', out)
    rc, refresh, err = remote(['ops/41_homolog.py', 'db-refresh'] + WAIT, '02b-copia-nova', out)
    summary['dbRefresh'] = refresh or {'rc': rc, 'error': err}
    if not refresh:
        return done('a cópia nova da produção falhou')
    # Foto dos números da cópia (= a produção de agora) ANTES das migrações da release; a de depois da
    # subida tem de ser igual (estoque, curvas, faturamento, sales_kpis e painel do Estoque).
    photo_before = photo(out, '02c-foto-da-copia-antes', copy=True) if suppliers else None
    rc, up, err = remote(['ops/41_homolog.py', 'up', release] + WAIT, '02-homologacao-up', out)
    summary['up'] = {k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up else {'rc': rc, 'error': err}
    if not up:
        return done('a homologação não subiu')
    if suppliers:
        summary['photoCopy'] = compare_photos(photo_before, photo(out, '02d-foto-da-copia-depois', copy=True))
    rc, mode, err = remote(['ops/40_stock.py', '--db=biomie_v2_hml', 'mode', 'on'], '03-estoque-liberado-na-copia', out)
    summary['stockMode'] = {'rc': rc, 'error': None if rc == 0 else err}
    if suppliers:
        rc, load, err = remote(['ops/41_homolog.py', 'suppliers-load', '30'] + WAIT, '03b-fornecedores-do-omie', out)
        summary['suppliersLoad'] = (
            {k: load.get(k) for k in ('exit', 'skipped', 'conflicts', 'after')} if load else {'rc': rc, 'error': err})
    rc, seed, err = remote(['ops/47_hml_replenishment_seed.py', '30'] + WAIT, '04-prazo-hipotetico', out)
    summary['hypotheticalLeadTime'] = seed or {'rc': rc, 'error': err}
    rc, engine, err = remote(['ops/41_homolog.py', 'intel-run'] + WAIT, '05-motor', out)
    if engine:
        events = [json.loads(line) for line in (engine.get('stdout') or '').splitlines() if line.startswith('{')]
        summary['engine'] = {'exit': engine.get('exit'), 'buildSeconds': engine.get('buildSeconds'),
                             'runSeconds': engine.get('runSeconds'),
                             'events': [e for e in events if e.get('event') in ('intel_published', 'intel_failed',
                                                                                 'intel_skipped', 'intel_company')]}
    else:
        summary['engine'] = {'rc': rc, 'error': err}
    if not engine or engine.get('exit') != 0:
        return done('o motor não publicou')
    rc, check, err = remote(['ops/43_intel_check.py', 'biomie_v2_hml'] + WAIT, '06-conferencia', out)
    summary['check'] = check or {'rc': rc, 'error': err}
    started = dt.datetime.now().isoformat(timespec='seconds')
    p = subprocess.run([sys.executable, str(BASE / 'ops' / '29_smoke.py'), '--stock', '--stock-mode', 'on',
                        '--curves-readonly', '--intel', '--hml', '--shots', f'intel5-{dt.date.today():%Y%m%d}']
                       + (['--suppliers'] if suppliers else []) + WAIT,
                       capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=4 * 3600,
                       env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    (out / '07-navegador.txt').write_text(f'# {started} rc={p.returncode}\n{p.stdout}\n--stderr--\n{p.stderr}',
                                         encoding='utf-8')
    try:
        browser = json.loads(p.stdout[p.stdout.find('{'):p.stdout.rfind('}') + 1])
    except ValueError:
        browser = None
    summary['browser'] = {'rc': p.returncode, 'ok': (browser or {}).get('ok'),
                          'steps': [{'name': s.get('step') or s.get('name'), 'ok': s.get('ok'), 'error': s.get('error')}
                                    for s in (browser or {}).get('steps', [])],
                          'problems': (browser or {}).get('problems'),
                          'error': None if browser else p.stderr.strip()[-600:]}
    if suppliers:
        prod = production_release(out)
        # Depois da ativação (30/10) a produção já roda esta release: o retorno testado é o da anterior.
        if prod == release:
            prod = PRODUCTION_RELEASE
        summary['rollbackRelease'] = prod
        rc, back, err = remote(['ops/41_homolog.py', 'up', prod] + WAIT, '07b-retorno-subida', out)
        summary['rollbackUp'] = ({k: back.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')}
                                 if back else {'rc': rc, 'error': err})
        if back:
            summary['rollbackRegression'] = smoke(['--hml'], '07c-retorno-navegador-regressao', out)
            summary['rollbackStock'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly', '--hml'],
                                             '07d-retorno-navegador-estoque', out)
    rc, down, err = remote(['ops/41_homolog.py', 'down'], '08-homologacao-down', out)
    summary['down'] = {'rc': rc}
    return done()


def production_release(out):
    """Release ativa na produção agora (stack.env); se a leitura falhar, a constante PRODUCTION_RELEASE."""
    rc, data, err = remote(['ops/49_release_ativa.py'], '00-release-da-producao', out)
    return (data or {}).get('release') or PRODUCTION_RELEASE


def validation_ok(release):
    """A validação de fornecedores do dia para esta release passou inteira? Devolve (ok, motivos)."""
    # A validação da noite pode terminar antes ou depois da meia-noite: vale a de hoje ou a de ontem.
    s = None
    for day in (dt.date.today(), dt.date.today() - dt.timedelta(days=1)):
        try:
            s = json.loads((LOGS / 'noturno' / f'{day:%Y%m%d}-inteligencia-fornecedores' / 'resumo.json')
                           .read_text(encoding='utf-8'))
            break
        except (OSError, ValueError):
            continue
    if s is None:
        return False, ['sem resumo da validação de hoje ou de ontem (ops/logs/noturno/<data>-inteligencia-fornecedores)']
    why = []
    if s.get('release') != release:
        why.append(f"a validação de hoje foi da release {s.get('release')}")
    if s.get('stopped'):
        why.append('a validação parou: ' + s['stopped'])
    if not (s.get('dbTests') or {}).get('allOk'):
        why.append('suítes do banco')
    if (s.get('engine') or {}).get('exit') != 0:
        why.append('motor')
    if not (s.get('check') or {}).get('allOk'):
        why.append('conferência 43')
    if not (s.get('browser') or {}).get('ok'):
        why.append('navegador')
    for key in ('rollbackRegression', 'rollbackStock'):
        if not (s.get(key) or {}).get('ok'):
            why.append('retorno: ' + key)
    # Número que mudou com as migrações barra a ativação; parte que não pôde ser medida fica só registrada.
    photo_copy = s.get('photoCopy') or {}
    if photo_copy.get('compared') and not photo_copy.get('equal'):
        why.append('números da cópia mudaram com as migrações: ' + ', '.join(photo_copy.get('different') or {}))
    return not why, why


SKIP_PHOTO = ('database', 'migrations', 'timing', 'seconds', 'ok')


def photo(out, name, copy=False):
    """Foto dos números (50_foto_producao, só leitura) da produção ou da cópia (--copia, na janela)."""
    rc, data, err = remote(['ops/50_foto_producao.py'] + (['--copia'] + WAIT if copy else []), name, out,
                           timeout=3600)
    return data or {'error': err or f'rc={rc}'}


def compare_photos(before, after):
    """Foto antes × depois: as partes (e, dentro delas, as chaves) que mudaram. Migrações e tempos ficam de
    fora; parte com erro em qualquer lado fica como não comparada (não conta como diferença)."""
    if not isinstance(before, dict) or not isinstance(after, dict) or 'error' in before or 'error' in after:
        return {'compared': False, 'error': ((before or {}).get('error') or (after or {}).get('error')
                                             or 'foto ausente')}
    failed = lambda v: isinstance(v, dict) and set(v) == {'error'}  # noqa: E731
    different, not_compared = {}, []
    for key in sorted((set(before) | set(after)) - set(SKIP_PHOTO)):
        a, b = before.get(key), after.get(key)
        if failed(a) or failed(b):
            not_compared.append(key)
        elif a != b:
            if isinstance(a, dict) and isinstance(b, dict):
                different[key] = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))[:20]
            else:
                different[key] = [str(a)[:120], str(b)[:120]]
    return {'compared': True, 'equal': not different, 'different': different, 'notCompared': not_compared,
            'migrations': [before.get('migrations'), after.get('migrations')],
            'seconds': [before.get('seconds'), after.get('seconds')]}


def worker_state(out, name):
    """Estado do worker da produção (25_load status, só leitura): o worker.status ou {}."""
    rc, data, err = remote(['ops/25_load.py', 'status'], name, out)
    return (data or {}).get('worker') or {}


def resume_worker(out, name):
    """Retoma o worker da produção (como em 23/10) e confere, um minuto depois, que ele saiu da pausa."""
    rc, data, err = remote(['ops/25_load.py', 'resume'], name, out)
    time.sleep(60)
    state = worker_state(out, name + '-estado')
    return {'rc': rc, 'control': data, 'state': state.get('state'), 'reason': state.get('reason'),
            'ok': rc == 0 and state.get('state') not in (None, 'PAUSED')}


#: Leituras de estoque do dia (o fechamento das 23:50 tem regra própria). O worker só abre cada leitura numa
#: janela de 5 minutos (SLOT_WINDOW_MINUTES): pausado nela, a leitura daquele horário se perde.
READING_SLOTS = (dt.time(7, 40), dt.time(12, 40), dt.time(17, 40))


def activation_slot():
    """Motivos para a ativação NÃO começar agora (lista vazia = pode): perto das cargas do worker (:21/:51),
    perto de uma leitura de estoque (20 min antes até 10 min depois) ou do fechamento (23:50), leitura de
    estoque na fila ou servidor carregado."""
    now = dt.datetime.now()
    why = []
    if now.minute % 30 > 10:
        why.append(f'minuto :{now.minute:02d} perto das cargas :21/:51')
    minutes = now.hour * 60 + now.minute
    for slot in READING_SLOTS:
        start = slot.hour * 60 + slot.minute
        if start - 20 <= minutes < start + 10:
            why.append(f'perto da leitura de estoque das {slot:%H:%M}')
    if now.time() >= dt.time(23, 15) or now.time() < dt.time(1, 30):
        why.append('perto do fechamento do estoque (23:50)')
    if not why:
        sys.path.insert(0, str(BASE / 'ops'))
        import janela_testes
        why += [r for r in janela_testes.reasons() if not r.startswith(('expediente', 'minuto'))]
    return why


def recent_db_tests(release, hours=3):
    """As suítes do banco desta release rodadas no servidor nas últimas horas (log do 22), se passaram."""
    limit = dt.datetime.now() - dt.timedelta(hours=hours)
    for log in sorted(LOGS.glob('*-22_test_database.log'), reverse=True):
        try:
            when = dt.datetime.strptime(log.name[:15], '%Y%m%d-%H%M%S')
        except ValueError:
            continue
        if when < limit:
            break
        text = log.read_text(encoding='utf-8', errors='replace')
        try:
            data = json.loads(text[text.find('{'):text.rfind('}') + 1])
        except ValueError:
            continue
        if data.get('release') == release:
            return {'log': log.name, 'allOk': bool(data.get('all_ok')),
                    'migrations': data.get('migrations_applied'),
                    'failures': {k: v.get('error') for k, v in (data.get('suites') or {}).items() if not v.get('ok')}}
    return None


def ativar(release, import_suppliers=False, now_reason=None):
    """Ativação na produção, só depois de a validação passar inteira, na mesma sequência da ativação de
    23/10: horário livre (longe das cargas e do fechamento do estoque) → worker pausado e parado → foto dos
    números → 21_activate_release (cópia de segurança verificada antes das migrações, migrações, imagem, web
    e worker) → foto de novo (tem de ser igual) → worker retomado → 42_intel (motor uma vez) → 43
    (conferência, só leitura) → importação única de fornecedores (se pedida) → navegador da produção.
    Se a ativação falhar, volta sozinha para a release anterior, retoma o worker e testa no navegador."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-ativacao-{release}'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'release': release, 'started': dt.datetime.now().isoformat(timespec='seconds'),
               'importSuppliers': import_suppliers}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        summary['rollback'] = ('python ops/remote.py ops/21_activate_release.py '
                               f"{summary.get('previous') or PRODUCTION_RELEASE} --start-worker")
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    # Passos pesados (conferência, importação) esperam a janela; no modo --agora vão como exceção registrada.
    heavy = [f'--fora-da-janela={now_reason}'] if now_reason else WAIT
    if now_reason:
        # Pedido do usuário de ativar sem a validação noturna (30/10): no lugar dela, as suítes do banco da
        # release no servidor (Postgres da produção, banco descartável) têm de passar inteiras.
        summary['mode'] = {'agora': now_reason}
        tests = recent_db_tests(release)
        if not tests:
            remote(['ops/22_test_database.py', release, f'--fora-da-janela={now_reason}'], '00a-testes-do-banco', out)
            tests = recent_db_tests(release)
        summary['dbTests'] = tests
        if not (tests or {}).get('allOk'):
            return done('as suítes do banco da release não passaram no servidor: nada mudou na produção')
    else:
        ok, why = validation_ok(release)
        summary['validation'] = {'ok': ok, 'problems': why}
        if not ok:
            return done('a validação não passou inteira: ' + '; '.join(why))
    summary['previous'] = production_release(out)
    if summary['previous'] == release:
        return done('esta release já está ativa na produção: nada a fazer')
    deadline = time.time() + 4 * 3600
    while (busy := activation_slot()):
        if time.time() > deadline:
            return done('sem horário livre para a ativação em 4 h: ' + '; '.join(busy))
        time.sleep(30)
    summary['slotAt'] = dt.datetime.now().isoformat(timespec='seconds')
    # A produção pode ter recebido uma correção enquanto esta ativação aguardava.
    # Confira novamente o retorno e preserve a UI ANTES de pausar o worker ou migrar.
    summary['previous'] = production_release(out)
    rc, ui, err = remote(['ops/51_ui_release_guard.py', release], '00a-preservacao-da-interface', out)
    summary['uiPreservation'] = ui if isinstance(ui, dict) else {'rc': rc, 'error': err}
    if rc != 0 or not isinstance(ui, dict) or ui.get('preserves_ui') is not True:
        return done('a release candidata precisa ser regenerada com a barra horizontal flutuante; '
                    'a preservação da interface não foi confirmada: nada mudou na produção')
    if ui.get('active') != summary['previous']:
        return done('a release da produção mudou durante a conferência: repita a ativação; '
                    'nada mudou na produção')
    if summary['previous'] == release:
        return done('esta release já está ativa na produção: nada a fazer')
    summary['workerBefore'] = {k: v for k, v in worker_state(out, '00b-worker-antes').items()
                               if k in ('state', 'reason', 'at', 'commit')}
    # Como em 23/10: pausa o worker e espera a etapa em andamento terminar (ele mostra PAUSED com o motivo).
    reason = f'ativacao {release}'
    remote(['ops/25_load.py', 'pause', reason], '00c-worker-pausa', out)
    limit = time.time() + 20 * 60
    while True:
        state = worker_state(out, '00d-worker-pausado')
        if state.get('state') == 'PAUSED' and state.get('reason') == reason:
            break
        if time.time() > limit:
            summary['workerResumed'] = resume_worker(out, '00e-worker-retomado')
            return done('o worker não pausou em 20 minutos: ativação cancelada e worker retomado')
        time.sleep(20)
    summary['workerPaused'] = {k: state.get(k) for k in ('state', 'reason', 'at')}
    # Foto dos números com o worker parado; a de depois da ativação tem de ser igual.
    photo_before = photo(out, '00f-foto-antes')
    rc, act, err = remote(['ops/21_activate_release.py', release, '--start-worker'], '01-ativacao', out,
                          timeout=3 * 3600)
    summary['activation'] = act or {'rc': rc, 'error': err}
    if rc != 0:
        # Retorno automático para a release anterior: o mesmo retorno testado na validação da noite.
        rc2, back, err2 = remote(['ops/21_activate_release.py', summary['previous'], '--start-worker'],
                                 '01r-retorno', out, timeout=3 * 3600)
        summary['rollbackRun'] = back or {'rc': rc2, 'error': err2}
        if rc2 != 0:
            return done('ATENÇÃO: a ativação falhou e o retorno automático também; o worker continua pausado')
        summary['activeAfterRollback'] = production_release(out)
        summary['workerResumed'] = resume_worker(out, '01s-worker-retomado')
        summary['rollbackBrowser'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly'],
                                           '01t-retorno-navegador', out)
        return done(f"a ativação falhou; a produção voltou sozinha para a {summary['previous']}")
    summary['active'] = production_release(out)
    summary['photo'] = compare_photos(photo_before, photo(out, '01a-foto-depois'))
    summary['workerResumed'] = resume_worker(out, '01b-worker-retomado')
    rc, engine, err = remote(['ops/42_intel.py', 'run', '--force'], '02-motor', out, timeout=3600)
    summary['engine'] = engine or {'rc': rc, 'error': err}
    rc, check, err = remote(['ops/43_intel_check.py', 'biomie_v2'] + heavy, '03-conferencia', out)
    summary['check'] = ({k: (check or {}).get(k) for k in ('allOk', 'phasesOk', 'phase5')}
                        if check else {'rc': rc, 'error': err})
    if import_suppliers:
        rc, imp, err = remote(['ops/40_stock.py', 'suppliers-import'] + heavy, '04-importacao-unica-fornecedores', out)
        summary['suppliersImport'] = imp or {'rc': rc, 'error': err}
    summary['browser'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly', '--intel', '--suppliers',
                                '--shots', f'producao-{dt.date.today():%Y%m%d}'], '05-navegador-producao', out)
    summary['workerAfter'] = {k: v for k, v in worker_state(out, '06-worker-depois').items()
                              if k in ('state', 'reason', 'at', 'commit')}
    return done()


def smoke(args, name, out):
    started = dt.datetime.now().isoformat(timespec='seconds')
    p = subprocess.run([sys.executable, str(BASE / 'ops' / '29_smoke.py')] + args + WAIT,
                       capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=4 * 3600,
                       env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    (out / f'{name}.txt').write_text(f'# {started} rc={p.returncode}\n{p.stdout}\n--stderr--\n{p.stderr}',
                                     encoding='utf-8')
    try:
        data = json.loads(p.stdout[p.stdout.find('{'):p.stdout.rfind('}') + 1])
    except ValueError:
        data = None
    return {'rc': p.returncode, 'ok': (data or {}).get('ok'),
            'failed': [{'name': s.get('name') or s.get('step'), 'error': s.get('error')}
                       for s in (data or {}).get('steps', []) if not s.get('ok')],
            'steps': len((data or {}).get('steps', [])), 'problems': (data or {}).get('problems'),
            'error': None if data else p.stderr.strip()[-600:]}


def trem(release):
    """Versão combinada (Matriz + sales_kpis + Inteligência + fornecedores) na homologação, com a comparação
    com a produção e o RETORNO: a release da produção sobe sobre o mesmo banco migrado e é testada."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-trem-{release}'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'release': release, 'production': PRODUCTION_RELEASE,
               'started': dt.datetime.now().isoformat(timespec='seconds')}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        remote(['ops/41_homolog.py', 'down'], '99-homologacao-down', out)
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    rc, tests, err = remote(['ops/22_test_database.py', release] + WAIT, '01-testes-do-banco', out)
    summary['dbTests'] = {'rc': rc, 'allOk': (tests or {}).get('all_ok'), 'error': None if tests else err,
                          'migrations': (tests or {}).get('migrations_applied'),
                          'suites': {k: ('pulada' if v.get('skipped') else v.get('ok'))
                                     for k, v in (tests or {}).get('suites', {}).items()},
                          'failures': {k: v.get('error') for k, v in (tests or {}).get('suites', {}).items()
                                       if not v.get('ok')},
                          'rollbackScripts': (tests or {}).get('rollback_scripts')}
    if not (tests or {}).get('all_ok'):
        return done('suítes do banco não passaram: a homologação não sobe com teste falhando')
    remote(['ops/41_homolog.py', 'down'], '02a-homologacao-down', out)
    rc, refresh, err = remote(['ops/41_homolog.py', 'db-refresh'] + WAIT, '02b-copia-nova', out)
    summary['dbRefresh'] = refresh or {'rc': rc, 'error': err}
    if not refresh:
        return done('a cópia nova da produção falhou')
    rc, up, err = remote(['ops/41_homolog.py', 'up', release] + WAIT, '03-subida-do-trem', out)
    summary['up'] = {k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up else {'rc': rc, 'error': err}
    if not up:
        return done('o trem não subiu')
    rc, _, err = remote(['ops/40_stock.py', '--db=biomie_v2_hml', 'mode', 'on'], '04-estoque-liberado-na-copia', out)
    rc, load, err = remote(['ops/41_homolog.py', 'suppliers-load', '30'] + WAIT, '05-fornecedores-do-omie', out)
    summary['suppliersLoad'] = (
        {k: load.get(k) for k in ('exit', 'skipped', 'conflicts', 'after')} if load else {'rc': rc, 'error': err})
    rc, seed, err = remote(['ops/47_hml_replenishment_seed.py', '30'] + WAIT, '06-prazo-de-teste', out)
    summary['testLeadTime'] = seed or {'rc': rc, 'error': err}
    rc, engine, err = remote(['ops/41_homolog.py', 'intel-run'] + WAIT, '07-motor', out)
    summary['engine'] = {'exit': (engine or {}).get('exit'), 'runSeconds': (engine or {}).get('runSeconds'),
                         'error': None if engine else err}
    rc, check, err = remote(['ops/43_intel_check.py', 'biomie_v2_hml'] + WAIT, '08-conferencia', out)
    summary['check'] = {k: (check or {}).get(k) for k in ('allOk', 'phasesOk', 'phase5')} if check else {'rc': rc, 'error': err}
    rc, cmp, err = remote(['ops/48_hml_vs_prod.py'] + WAIT, '09-copia-x-producao', out)
    summary['vsProduction'] = cmp or {'rc': rc, 'error': err}
    summary['browserRegression'] = smoke(['--hml'], '10-navegador-regressao', out)
    summary['browserStock'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly', '--intel', '--suppliers', '--hml',
                                     '--shots', f'trem-{dt.date.today():%Y%m%d}'], '11-navegador-estoque', out)
    # Retorno: a release da produção sobe sobre o banco com as migrações novas (o executor ignora as que não
    # conhece) e as telas de hoje continuam funcionando.
    summary['production'] = production_release(out)
    rc, back, err = remote(['ops/41_homolog.py', 'up', summary['production']] + WAIT, '12-retorno-subida', out)
    summary['rollbackUp'] = {k: back.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if back else {'rc': rc, 'error': err}
    if back:
        summary['rollbackRegression'] = smoke(['--hml'], '13-retorno-navegador-regressao', out)
        summary['rollbackStock'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly', '--hml'],
                                         '14-retorno-navegador-estoque', out)
    return done()


def banco(release):
    """Suítes do banco de uma release (ex.: o trem de integração), na fila das tarefas noturnas."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-banco-{release}'
    out.mkdir(parents=True, exist_ok=True)
    rc, tests, err = remote(['ops/22_test_database.py', release] + WAIT, '01-testes-do-banco', out)
    summary = {'release': release, 'rc': rc, 'allOk': (tests or {}).get('all_ok'), 'error': None if tests else err,
               'migrations': (tests or {}).get('migrations_applied'),
               'suites': {k: ('pulada' if v.get('skipped') else v.get('ok'))
                          for k, v in (tests or {}).get('suites', {}).items()},
               'failures': {k: v.get('error') for k, v in (tests or {}).get('suites', {}).items() if not v.get('ok')},
               'rollbackScripts': (tests or {}).get('rollback_scripts')}
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


if __name__ == '__main__':
    # Os passos chamam ops/<script>.py por caminho relativo: roda sempre a partir da pasta do projeto,
    # de onde quer que o comando tenha sido digitado.
    os.chdir(BASE)
    sys.argv = [a for a in sys.argv if a != '--teste']
    task = sys.argv[1] if len(sys.argv) > 1 else ''
    lock = night_lock() if task in ('matriz', 'sales-kpis', 'intel', 'intel-fornecedores', 'banco', 'trem',
                                    'ativar') else None
    if task == 'intel':
        intel(sys.argv[2] if len(sys.argv) > 2 else INTEL_RELEASE)
    elif task == 'banco':
        if len(sys.argv) < 3:
            raise SystemExit('uso: banco <release>')
        banco(sys.argv[2])
    elif task == 'intel-fornecedores':
        intel(sys.argv[2] if len(sys.argv) > 2 else SUPPLIERS_RELEASE, suppliers=True)
    elif task == 'trem':
        trem(sys.argv[2] if len(sys.argv) > 2 else TRAIN_RELEASE)
    elif task == 'ativar':
        args = [a for a in sys.argv[2:] if not a.startswith('--')]
        if not args:
            raise SystemExit('uso: ativar <release> [--importar-fornecedores] [--agora="motivo"]')
        # --agora="motivo": ativação pedida pelo usuário sem a validação noturna (gate = suítes do banco).
        now_reason = next((a.split('=', 1)[1].strip() for a in sys.argv if a.startswith('--agora=')), None)
        if now_reason is not None and len(now_reason) < 10:
            raise SystemExit('--agora precisa de um motivo (10 caracteres ou mais).')
        ativar(args[0], import_suppliers='--importar-fornecedores' in sys.argv, now_reason=now_reason)
    elif task == 'matriz':
        release = sys.argv[2] if len(sys.argv) > 2 else 'ba4ee4b03c40'
        rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
        matriz(release, rounds)
    elif task == 'sales-kpis':
        sales_kpis(sys.argv[2] if len(sys.argv) > 2 else SALES_KPIS_RELEASE)
    else:
        raise SystemExit(__doc__)
