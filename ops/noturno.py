"""Trabalhos noturnos da HOMOLOGAÇÃO, para o Agendador de Tarefas do Windows (não dependem de uma
sessão do Claude aberta). Cada passo pesado passa pela janela de testes (--esperar) e tudo fica em
ops/logs/noturno/<data>-<tarefa>/ (um arquivo por passo + resumo.json). Nada aqui muda a produção.

    python ops/noturno.py matriz [release] [rodadas]   # teste controlado da correção da MAG Matriz
    python ops/noturno.py matriz-teste <release> [rodadas]  # idem com cópia nova e a homologação no ar
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
    python ops/noturno.py intel-diaria-copia [release] # ANÁLISE DIÁRIA na cópia: cópia nova, subida, envio
                                                       # da rotina (ops/intel_diaria.py) e o teste 53 com
                                                       # cron de verdade, depois a conferência 43
    python ops/noturno.py intel-diaria-ativar          # PRODUÇÃO (autorização de 03/11/2026): só com o teste
                                                       # da cópia de hoje inteiro e a mesma rotina; instala
                                                       # o cron, liga, roda a 1ª vez, confere (43) e testa no
                                                       # navegador; 1ª execução sem análise conferida =
                                                       # desliga e retira a agenda sozinho
    python ops/noturno.py legado-backups               # BIomie antigo (03/11/2026): backup do v2 sem o legado,
                                                       # arquivo final CIFRADO do banco antigo e só então
                                                       # desliga o dump sem cifra das 03:00 (nada é apagado)
    python ops/noturno.py legado-restauracao           # teste de restauração do arquivo cifrado do legado num
                                                       # MariaDB descartável, tabela a tabela (nada é apagado)
    python ops/noturno.py legado-exclusao <local> <fora>  # (autorização de 04/11/2026) cópia de 19/10 cifrada e
                                                       # exclusão das cópias SEM cifra, só com todos os portões
    python ops/noturno.py legado-passo1                # (autorização de 04/11/2026) desativação, passo 1: tarefas
                                                       # restantes do legado comentadas (nada é apagado)
    python ops/noturno.py legado-passo2                # (mesma autorização) passo 2: biomie-python.service parado
                                                       # e fora do boot, com portões (nada é apagado)
    Opções de horário (qualquer tarefa): --comecar-ate=HH:MM (se a vez na fila chegar depois, desiste sem fazer
    nada) e --ate=HH:MM (nenhum passo pesado começa depois; o passo 2 do legado também respeita).
    python ops/noturno.py plano <release>              # PLANO DE VOO (0050) na homologação: suítes, cópia nova,
                                                       # foto antes/depois das migrações, conferência antigo ×
                                                       # novo e tempos (56), navegador com gravação na cópia,
                                                       # regressão e RETORNO (a release da produção sobre o
                                                       # banco já migrado)
    python ops/noturno.py ativar-plano <release> [--anterior=<release>]
                                                       # ATIVAÇÃO do Plano de Voo na produção (só com
                                                       # autorização do usuário): exige a homologação do dia
                                                       # inteira; só se a produção estiver na --anterior; só
                                                       # de madrugada (18:30–05:30); horário livre, interface
                                                       # preservada, worker pausado, foto igual antes/depois,
                                                       # navegador; retorno automático se a ativação ou o
                                                       # navegador na produção falharem

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
import hashlib
import json
import msvcrt
import os
import pathlib
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
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
SUPPLIERS_RELEASE = 'cdb333a1f2a5'
TRAIN_RELEASE = '266d297add0b'
# Release em produção desde 30/10 10:35 (Inteligência + fornecedores + barra de rolagem). Só um valor de
# reserva: a ativação e a validação leem a release ativa no servidor (49) antes de agir.
PRODUCTION_RELEASE = 'cdb333a1f2a5'
# Retorno da produção: a release anterior (só o web, com a barra de rolagem; mesmo banco da 1240466bf0c3).
PREVIOUS_RELEASE = 'cb9aeeb06539'
# Rotina da análise diária (roda no servidor, chamada pelo cron); enviada por SSH, conferida pelo sha256.
RUNNER_LOCAL = BASE / 'ops' / 'intel_diaria.py'
RUNNER_REMOTE = '/opt/biomie-v2/bin/intel_diaria.py'
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
       '-i', str(pathlib.Path.home() / '.ssh/hostinger_srv1851839_ed25519'), 'root@179.197.238.57']


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


def clock_option(argv, name, start):
    """--nome=HH:MM → o horário mais próximo de `start` (até 12 h antes ou depois). À noite, --ate=23:00 é hoje e
    --ate=01:00 é amanhã; para uma tarefa que começa depois do horário, ele já passou."""
    value = next((a.split('=', 1)[1] for a in argv if a.startswith(name + '=')), None)
    if value is None:
        return None
    try:
        hour, minute = (int(x) for x in value.split(':'))
        moment = start.replace(hour=hour, minute=minute, second=0, microsecond=0)
    except ValueError:
        raise SystemExit(f'{name} precisa de HH:MM (recebi {value!r})')
    if moment < start - dt.timedelta(hours=12):
        moment += dt.timedelta(days=1)
    elif moment > start + dt.timedelta(hours=12):
        moment -= dt.timedelta(days=1)
    return moment


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


def browser_problem():
    """O navegador local abre? (Playwright/Chromium de ops/browser, no perfil do usuário: a tarefa do Agendador tem de
    rodar como ele.) Em 05/11 18:30 o Playwright não abriu e a homologação gastou 1h40 da cópia à toa. Devolve None se
    abriu, senão o erro. Mesmo teste do browser_problem() do plano_voo_noite.py (biomie-24)."""
    code = ("const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();"
            "const p=await b.newPage();await p.setContent('<p>ok</p>');console.log(await p.textContent('p'));"
            "await b.close();})().catch(e=>{console.error(String(e));process.exit(1)})")
    try:
        p = subprocess.run(['node', '-e', code], cwd=BASE / 'ops' / 'browser', capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=180)
    except (OSError, subprocess.TimeoutExpired) as e:
        return f'{type(e).__name__}: {e}'[:500]
    return None if p.returncode == 0 and p.stdout.strip() == 'ok' else (p.stderr or p.stdout or '?')[-500:]


def homolog_down(out, summary, name='99-homologacao-down', early=True):
    """Desliga a homologação (41_homolog.py down) e registra em summary['down']. Nunca levanta exceção: quem chama
    já está saindo por outra falha. A cópia não pode ficar ligada: a fila seguinte e o portão do MAG AI (para se
    houver biomie-hml rodando) contam com ela desligada."""
    try:
        rc, _, _ = remote(['ops/41_homolog.py', 'down'], name, out, timeout=30 * 60)
        summary['down'] = {'rc': rc, 'early': early}
    except BaseException as error:  # noqa: BLE001
        summary['down'] = {'early': early, 'error': f'{type(error).__name__}: {error}'[:300]}


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


def matriz_teste(release, rounds):
    """Teste controlado da correção da MAG Matriz com a cópia no ar: cópia nova → homologação com a release de
    teste (correção + rastreio; o mesmo código do worker da candidata) → as rodadas do `matriz` → down."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-matriz-preparo'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'release': release, 'started': dt.datetime.now().isoformat(timespec='seconds')}
    try:
        remote(['ops/41_homolog.py', 'down'], '01a-homologacao-down', out)
        rc, refresh, err = remote(['ops/41_homolog.py', 'db-refresh'] + WAIT, '01b-copia-nova', out)
        summary['dbRefresh'] = refresh or {'rc': rc, 'error': err}
        rc, up, err = (remote(['ops/41_homolog.py', 'up', release] + WAIT, '02-homologacao-up', out) if refresh
                       else (1, None, ''))
        summary['up'] = ({k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up
                         else {'rc': rc, 'error': err})
        if up:
            matriz(release, rounds)
    except BaseException as error:
        summary['stopped'] = f'exceção no teste: {type(error).__name__}: {error}'[:500]
        raise
    finally:
        # Sempre desliga, também quando uma rodada levanta exceção (até 06/11 a cópia ficava ligada).
        homolog_down(out, summary, early='stopped' in summary)
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

    problem = browser_problem()
    if problem:
        summary['browserPreCheck'] = problem
        return done('o navegador local não abre (Playwright/Chromium): nada foi feito na cópia; ' + problem[:200])
    rc, tests, err = remote(['ops/22_test_database.py', release] + WAIT, '01-testes-do-banco', out)
    summary['dbTests'] = {'rc': rc, 'allOk': (tests or {}).get('all_ok'), 'error': None if tests else err,
                          'migrations': (tests or {}).get('migrations_applied'),
                          'suites': {k: ('pulada' if v.get('skipped') else v.get('ok'))
                                     for k, v in (tests or {}).get('suites', {}).items()},
                          'failures': {k: v.get('error') for k, v in (tests or {}).get('suites', {}).items()
                                       if not v.get('ok')}}
    if not (tests or {}).get('all_ok'):
        return done('suítes do banco não passaram: a homologação não sobe com teste falhando')

    def stop(reason):
        """Saída antecipada depois de mexer na cópia: desliga a homologação ANTES de registrar. Até 06/11 a cópia
        nova, a subida ou o motor que falhavam saíam sem o down e a cópia podia ficar ligada."""
        homolog_down(out, summary)
        return done(reason)

    try:
        remote(['ops/41_homolog.py', 'down'], '02a-homologacao-down', out)
        rc, refresh, err = remote(['ops/41_homolog.py', 'db-refresh'] + WAIT, '02b-copia-nova', out)
        summary['dbRefresh'] = refresh or {'rc': rc, 'error': err}
        if not refresh:
            return stop('a cópia nova da produção falhou')
        # Foto dos números da cópia (= a produção de agora) ANTES das migrações da release; a de depois da
        # subida tem de ser igual (estoque, curvas, faturamento, sales_kpis e painel do Estoque).
        photo_before = photo(out, '02c-foto-da-copia-antes', copy=True) if suppliers else None
        rc, up, err = remote(['ops/41_homolog.py', 'up', release] + WAIT, '02-homologacao-up', out)
        summary['up'] = ({k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up
                         else {'rc': rc, 'error': err})
        if not up:
            return stop('a homologação não subiu')
        if suppliers:
            summary['photoCopy'] = compare_photos(photo_before, photo(out, '02d-foto-da-copia-depois', copy=True))
        rc, mode, err = remote(['ops/40_stock.py', '--db=biomie_v2_hml', 'mode', 'on'], '03-estoque-liberado-na-copia',
                               out)
        summary['stockMode'] = {'rc': rc, 'error': None if rc == 0 else err}
        if suppliers:
            # Empresa por empresa, cada uma só na janela livre da sua chave (03/11: pular tudo por uma chave ocupada
            # deixou a homologação sem leitura do Omie); prazo total de 90 min.
            rc, load, err = remote(['ops/41_homolog.py', 'suppliers-load', '90'] + WAIT, '03b-fornecedores-do-omie',
                                   out)
            summary['suppliersLoad'] = (
                {k: load.get(k) for k in ('complete', 'notLoaded', 'companies', 'after')} if load
                else {'rc': rc, 'error': err})
        rc, seed, err = remote(['ops/47_hml_replenishment_seed.py', '30'] + WAIT, '04-prazo-hipotetico', out)
        summary['hypotheticalLeadTime'] = seed or {'rc': rc, 'error': err}
        rc, engine, err = remote(['ops/41_homolog.py', 'intel-run'] + WAIT, '05-motor', out)
        if engine:
            events = [json.loads(line) for line in (engine.get('stdout') or '').splitlines() if line.startswith('{')]
            summary['engine'] = {'exit': engine.get('exit'), 'buildSeconds': engine.get('buildSeconds'),
                                 'runSeconds': engine.get('runSeconds'),
                                 'events': [e for e in events if e.get('event') in (
                                     'intel_published', 'intel_failed', 'intel_skipped', 'intel_company')]}
        else:
            summary['engine'] = {'rc': rc, 'error': err}
        if not engine or engine.get('exit') != 0:
            return stop('o motor não publicou')
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
        summary['browser'] = browser_result(p)
        if suppliers:
            # Desfazer da importação (pré-requisito da importação na produção, 06/11): ensaio e desfazer de verdade
            # na cópia. Só o que veio do Omie sai; prazos (os de teste do 47), fornecedor principal e vínculos
            # manuais ficam. A ativação com --importar-fornecedores exige este passo inteiro (suppliers_undo_ok).
            rc, undo, err = remote(['ops/40_stock.py', '--db=biomie_v2_hml', 'suppliers-undo', '--confirmar'] + WAIT,
                                   '07a-desfazer-fornecedores', out)
            summary['suppliersUndo'] = ({k: undo.get(k) for k in ('ok', 'sameAsTrial', 'result', 'beforeCopy',
                                                                   'removedCopy')} if undo else {'rc': rc, 'error': err})
            prod = production_release(out)
            # Depois da ativação (30/10) a produção já roda esta release: o retorno testado é o da anterior.
            if prod == release:
                prod = PREVIOUS_RELEASE
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
    except BaseException as error:
        # Exceção no meio (tempo esgotado de um passo, rede, Ctrl-C): desliga a cópia, registra e repassa.
        homolog_down(out, summary)
        done(f'exceção na homologação: {type(error).__name__}: {error}'[:500])
        raise


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


def suppliers_undo_ok(release):
    """O desfazer da importação de fornecedores passou na cópia na validação de hoje ou de ontem desta release?
    Devolve (ok, motivos). Sem isso, nenhuma importação de fornecedores na produção."""
    s = None
    for day in (dt.date.today(), dt.date.today() - dt.timedelta(days=1)):
        try:
            s = json.loads((LOGS / 'noturno' / f'{day:%Y%m%d}-inteligencia-fornecedores' / 'resumo.json')
                           .read_text(encoding='utf-8'))
            break
        except (OSError, ValueError):
            continue
    if s is None:
        return False, ['sem validação com fornecedores de hoje ou de ontem']
    why = []
    if s.get('release') != release:
        why.append(f"a validação com fornecedores foi da release {s.get('release')}")
    undo = s.get('suppliersUndo') or {}
    load = s.get('suppliersLoad') or {}
    if not load.get('complete'):
        why.append('a importação de teste na cópia não terminou')
    if not (undo.get('ok') and undo.get('sameAsTrial')):
        why.append('o desfazer da importação não passou inteiro na cópia')
    companies = (undo.get('result') or {}).get('companies') or []
    if not companies or not all(c.get('userDataIntact') and c.get('leftFromOmie') == 0 for c in companies):
        why.append('o desfazer na cópia deixou dados do Omie ou mexeu em dados das pessoas')
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
    if import_suppliers:
        # Importação na produção só com o desfazer testado na cópia (06/11), conferido ANTES de mexer em qualquer coisa.
        ok, why = suppliers_undo_ok(release)
        summary['suppliersUndoTested'] = {'ok': ok, 'problems': why}
        if not ok:
            return done('importação pedida sem o desfazer testado na cópia: ' + '; '.join(why) + '; nada mudou na produção')
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
        summary['suppliersRollback'] = 'python ops/remote.py ops/40_stock.py suppliers-undo --confirmar'
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
    return browser_result(p)


def browser_result(p):
    """Resultado do 29_smoke (p = o processo já terminado). O relatório traz o navegador dentro de 'browser':
    no teste do Estoque/admin, um objeto {ok, steps, problems}; no de regressão (sem --stock), uma lista com
    uma entrada por conta. Traz também 'browser_exit' (o próprio teste sai com 1 se algo falhou) e 'cleanup'
    (usuários de teste apagados). Passa só com o teste inteiro aprovado e os dois processos sem erro."""
    try:
        data = json.loads(p.stdout[p.stdout.find('{'):p.stdout.rfind('}') + 1])
    except ValueError:
        data = None
    data = data if isinstance(data, dict) else {}
    browser = data.get('browser')
    if isinstance(browser, dict):
        steps = browser.get('steps') or []
        failed = [{'name': s.get('name') or s.get('step'), 'error': s.get('error')} for s in steps if not s.get('ok')]
        passed = browser.get('ok') is True and not failed
    elif isinstance(browser, list):
        steps = browser
        failed = [{'name': r.get('account'), 'error': r.get('failure') or 'login, novo login, servidor ou CSP'}
                  for r in browser if not r.get('login') or not r.get('relogin') or r.get('failure')
                  or r.get('serverFailures') or r.get('cspViolations')]
        passed = bool(browser) and not failed
    else:
        steps, failed, passed = [], [], False
    return {'rc': p.returncode, 'ok': passed and p.returncode == 0 and data.get('browser_exit') == 0,
            'failed': failed, 'steps': len(steps),
            'problems': browser.get('problems') if isinstance(browser, dict) else None,
            'cleanupOk': any(isinstance(c, dict) and c.get('remaining_smoke_users') == 0 and not c.get('orphan_sessions')
                             for c in data.get('cleanup') or []),
            'error': None if browser is not None else
            (data.get('browser_error') or p.stderr.strip() or 'sem resultado do navegador')[-600:]}


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
        homolog_down(out, summary, early=bool(reason))
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    try:
        problem = browser_problem()
        if problem:
            summary['browserPreCheck'] = problem
            return done('o navegador local não abre (Playwright/Chromium): nada foi feito na cópia; ' + problem[:200])
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
        summary['up'] = ({k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up
                         else {'rc': rc, 'error': err})
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
        summary['check'] = ({k: (check or {}).get(k) for k in ('allOk', 'phasesOk', 'phase5')} if check
                            else {'rc': rc, 'error': err})
        rc, cmp, err = remote(['ops/48_hml_vs_prod.py'] + WAIT, '09-copia-x-producao', out)
        summary['vsProduction'] = cmp or {'rc': rc, 'error': err}
        summary['browserRegression'] = smoke(['--hml'], '10-navegador-regressao', out)
        summary['browserStock'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly', '--intel', '--suppliers',
                                         '--hml', '--shots', f'trem-{dt.date.today():%Y%m%d}'], '11-navegador-estoque', out)
        # Retorno: a release da produção sobe sobre o banco com as migrações novas (o executor ignora as que não
        # conhece) e as telas de hoje continuam funcionando.
        summary['production'] = production_release(out)
        rc, back, err = remote(['ops/41_homolog.py', 'up', summary['production']] + WAIT, '12-retorno-subida', out)
        summary['rollbackUp'] = ({k: back.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if back
                                 else {'rc': rc, 'error': err})
        if back:
            summary['rollbackRegression'] = smoke(['--hml'], '13-retorno-navegador-regressao', out)
            summary['rollbackStock'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly', '--hml'],
                                             '14-retorno-navegador-estoque', out)
        return done()
    except BaseException as error:
        # Exceção no meio: o done() desliga a cópia (homolog_down nunca levanta), registra e a exceção segue.
        done(f'exceção no trem: {type(error).__name__}: {error}'[:500])
        raise


def runner_bytes():
    """A rotina como vai para o servidor: sempre com fim de linha LF (o Windows pode gravar CRLF)."""
    return RUNNER_LOCAL.read_bytes().replace(b'\r\n', b'\n')


def upload_runner(out, name):
    """Envia ops/intel_diaria.py para /opt/biomie-v2/bin/intel_diaria.py (0700, troca atômica) e confere o
    sha256 dos dois lados. Só a rotina: o cron é instalado à parte (42_intel.py agenda instalar)."""
    data = runner_bytes()
    digest = hashlib.sha256(data).hexdigest()
    command = (f'umask 077 && mkdir -p /opt/biomie-v2/bin && cat > {RUNNER_REMOTE}.novo && '
               f'chmod 0700 {RUNNER_REMOTE}.novo && mv -f {RUNNER_REMOTE}.novo {RUNNER_REMOTE} && '
               f'sha256sum {RUNNER_REMOTE}')
    p = subprocess.run(SSH + [command], input=data, capture_output=True, timeout=120)
    text = p.stdout.decode('utf-8', 'replace').split()
    remote_digest = text[0] if p.returncode == 0 and text else None
    result = {'local': digest, 'remote': remote_digest, 'ok': remote_digest == digest, 'bytes': len(data),
              'rc': p.returncode, 'error': p.stderr.decode('utf-8', 'replace').strip()[-300:] or None}
    (out / f'{name}.txt').write_text(json.dumps(result, indent=1), encoding='utf-8')
    return result


def intel_diaria_copia(release=None):
    """Análise diária na cópia: cópia NOVA da produção (= a produção agora: inteligência desligada) →
    homologação com a release da produção → rotina enviada → teste 53 (cron de verdade, idempotência, nova
    tentativa, trava, falha no meio, execução parada, verificação e desligamento) → conferência 43 → down."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-inteligencia-diaria-copia'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'started': dt.datetime.now().isoformat(timespec='seconds')}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        homolog_down(out, summary, early=bool(reason))
        test, check, runner = summary.get('test') or {}, summary.get('check') or {}, summary.get('runner') or {}
        summary['ok'] = bool(not summary.get('stopped') and runner.get('ok') and test.get('allOk')
                             and test.get('runnerSha256') == runner.get('local') and check.get('allOk'))
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    try:
        summary['release'] = release or production_release(out)
        remote(['ops/41_homolog.py', 'down'], '01a-homologacao-down', out)
        rc, refresh, err = remote(['ops/41_homolog.py', 'db-refresh'] + WAIT, '01b-copia-nova', out)
        summary['dbRefresh'] = refresh or {'rc': rc, 'error': err}
        if not refresh:
            return done('a cópia nova da produção falhou')
        rc, up, err = remote(['ops/41_homolog.py', 'up', summary['release']] + WAIT, '02-homologacao-up', out)
        summary['up'] = ({k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up
                         else {'rc': rc, 'error': err})
        if not up:
            return done('a homologação não subiu')
        summary['runner'] = upload_runner(out, '03-rotina-enviada')
        if not summary['runner']['ok']:
            return done('a rotina não chegou inteira ao servidor')
        rc, test, err = remote(['ops/53_intel_diaria_teste.py'] + WAIT, '04-teste-da-rotina', out, timeout=3 * 3600)
        summary['test'] = ({k: test.get(k) for k in ('allOk', 'failed', 'checks', 'runnerSha256', 'cron',
                                                      'engineSeconds', 'timeline', 'history')}
                           if test else {'rc': rc, 'error': err})
        rc, check, err = remote(['ops/43_intel_check.py', 'biomie_v2_hml'] + WAIT, '05-conferencia', out)
        summary['check'] = ({k: check.get(k) for k in ('allOk', 'phasesOk', 'notes', 'companies')}
                            if check else {'rc': rc, 'error': err})
        return done()
    except BaseException as error:
        # Exceção no meio: o done() desliga a cópia (homolog_down nunca levanta), registra e a exceção segue.
        done(f'exceção na análise diária da cópia: {type(error).__name__}: {error}'[:500])
        raise


def intel_diaria_ok():
    """O teste da análise diária na cópia (hoje ou ontem) passou inteiro? Devolve (ok, motivos, sha256 testado)."""
    s = None
    for day in (dt.date.today(), dt.date.today() - dt.timedelta(days=1)):
        try:
            s = json.loads((LOGS / 'noturno' / f'{day:%Y%m%d}-inteligencia-diaria-copia' / 'resumo.json')
                           .read_text(encoding='utf-8'))
            break
        except (OSError, ValueError):
            continue
    if s is None:
        return False, ['sem resumo do teste na cópia de hoje ou de ontem'], None
    why = []
    if s.get('stopped'):
        why.append('o teste parou: ' + s['stopped'])
    if not (s.get('runner') or {}).get('ok'):
        why.append('a rotina não chegou inteira ao servidor')
    test = s.get('test') or {}
    if not test.get('allOk'):
        why.append('conferências do teste: ' + ', '.join(test.get('failed') or ['sem resultado']))
    if test.get('runnerSha256') != (s.get('runner') or {}).get('local'):
        why.append('a rotina testada não é a enviada')
    if not (s.get('check') or {}).get('allOk'):
        why.append('conferência 43 da cópia')
    return not why, why, (s.get('runner') or {}).get('local')


def intel_rollback(out):
    """Desligamento da análise diária: chave desligada (a rotina deixa de rodar o motor) e cron retirado. A tela
    continua com a última análise publicada."""
    rc1, off, err1 = remote(['ops/42_intel.py', 'disable'], '98-inteligencia-desligada', out)
    rc2, gone, err2 = remote(['ops/42_intel.py', 'agenda', 'remover'], '99-agenda-retirada', out)
    return {'disabled': rc1 == 0 and (off or {}).get('enabled') is False,
            'cronRemoved': rc2 == 0 and (gone or {}).get('cron', {}).get('installed') is False,
            'errors': [e for e in (err1 if rc1 else None, err2 if rc2 else None) if e]}


def intel_diaria_ativar():
    """Liga a análise diária na PRODUÇÃO (autorização do usuário de 03/11/2026: 06:33, persistente no servidor,
    depois do teste na cópia). Primeira execução na hora, pela mesma rotina do cron, para mostrar o resultado."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-inteligencia-diaria-ativacao'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'started': dt.datetime.now().isoformat(timespec='seconds')}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        summary['rollback'] = ('python ops/remote.py ops/42_intel.py disable && '
                               'python ops/remote.py ops/42_intel.py agenda remover')
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    ok, why, tested = intel_diaria_ok()
    summary['validation'] = {'ok': ok, 'problems': why, 'testedSha256': tested}
    if not ok:
        return done('o teste na cópia não passou inteiro: nada mudou na produção')
    if hashlib.sha256(runner_bytes()).hexdigest() != tested:
        return done('a rotina mudou depois do teste na cópia: teste de novo; nada mudou na produção')
    summary['release'] = production_release(out)
    deadline = time.time() + 4 * 3600
    while (busy := activation_slot()):
        if time.time() > deadline:
            return done('sem horário livre em 4 h: ' + '; '.join(busy))
        time.sleep(30)
    summary['slotAt'] = dt.datetime.now().isoformat(timespec='seconds')
    summary['runner'] = upload_runner(out, '01-rotina-enviada')
    if not summary['runner']['ok'] or summary['runner']['remote'] != tested:
        return done('a rotina não chegou inteira ao servidor: nada ligado')
    rc, inst, err = remote(['ops/42_intel.py', 'agenda', 'instalar', f'--sha256={tested}'], '02-agenda-instalada', out)
    summary['install'] = {'rc': rc, 'cron': (inst or {}).get('cron'), 'error': None if inst else err}
    if rc != 0 or not ((inst or {}).get('cron') or {}).get('expected'):
        summary['rollbackRun'] = intel_rollback(out)
        return done('a agenda não foi instalada como esperado: retirada; inteligência continua desligada')
    rc, on, err = remote(['ops/42_intel.py', 'enable'], '03-inteligencia-ligada', out)
    summary['enabled'] = (on or {}).get('enabled')
    if rc != 0 or summary['enabled'] is not True:
        summary['rollbackRun'] = intel_rollback(out)
        return done('a inteligência não ligou: agenda retirada')
    rc, first, err = remote(['ops/42_intel.py', 'agenda', 'executar'], '04-primeira-execucao', out, timeout=3600)
    situation = (first or {}).get('situacao') or {}
    summary['first'] = situation or {'rc': rc, 'error': err}
    if situation.get('resultado') != 'publicada' or situation.get('consistente') is not True:
        summary['rollbackRun'] = intel_rollback(out)
        return done('a primeira execução não publicou uma análise conferida: análise diária DESLIGADA de novo e '
                    'agenda retirada (a tela segue com a última análise publicada)')
    rc, check, err = remote(['ops/43_intel_check.py', 'biomie_v2'] + WAIT, '05-conferencia', out)
    summary['check'] = ({k: check.get(k) for k in ('allOk', 'phasesOk', 'notes', 'companies')}
                        if check else {'rc': rc, 'error': err})
    if not (check or {}).get('allOk'):
        summary['rollbackRun'] = intel_rollback(out)
        return done('a conferência 43 da produção não passou: análise diária DESLIGADA de novo e agenda retirada')
    rc, agenda, err = remote(['ops/42_intel.py', 'agenda', 'status'], '06-agenda', out)
    summary['agenda'] = ({k: agenda.get(k) for k in ('cron', 'runner', 'logrotate', 'pin', 'engine')}
                         if agenda else {'rc': rc, 'error': err})
    summary['browser'] = smoke(['--stock', '--stock-mode', 'on', '--curves-readonly', '--intel',
                                '--shots', f'intel-diaria-{dt.date.today():%Y%m%d}'], '07-navegador-producao', out)
    return done()


def night_slot():
    """Motivos para um passo pesado na PRODUÇÃO não começar agora (a mesma janela dos testes: fora do
    expediente, minutos :00–:12/:30–:42, sem leitura de estoque, servidor folgado)."""
    sys.path.insert(0, str(BASE / 'ops'))
    import janela_testes
    return janela_testes.reasons()


def legado_backups():
    """BIomie antigo (autorização de 03/11/2026): backup do v2 sem depender do legado → arquivo final CIFRADO do
    banco antigo, conferido e copiado para fora → só então desliga o dump SEM cifra das 03:00. Nada é apagado."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-legado-backups'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'started': dt.datetime.now().isoformat(timespec='seconds')}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        rc, after, err = remote(['ops/54_legado.py', 'status'], '04-situacao-depois', out)
        summary['after'] = after or {'rc': rc, 'error': err}
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        summary['rollback'] = {'backupV2': 'python ops/remote.py ops/54_legado.py desfazer-backup-v2',
                               'textoPuro': 'python ops/remote.py ops/54_legado.py desfazer-parar-texto-puro'}
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    deadline = time.time() + 6 * 3600
    while (busy := night_slot()):
        if time.time() > deadline:
            return done('sem horário livre em 6 h: ' + '; '.join(busy))
        time.sleep(60)
    rc, before, err = remote(['ops/54_legado.py', 'status'], '00-situacao-antes', out)
    summary['before'] = before or {'rc': rc, 'error': err}
    rc, v2, err = remote(['ops/54_legado.py', 'backup-v2'], '01-backup-v2-sem-o-legado', out, timeout=2 * 3600)
    summary['backupV2'] = v2 or {'rc': rc, 'error': err}
    rc, arch, err = remote(['ops/54_legado.py', 'arquivo-cifrado'], '02-arquivo-cifrado-do-legado', out, timeout=2 * 3600)
    summary['archive'] = arch or {'rc': rc, 'error': err}
    if rc != 0 or not (arch or {}).get('ok'):
        return done('arquivo cifrado não conferido: o dump antigo das 03:00 continua (nada desligado)')
    rc, stop, err = remote(['ops/54_legado.py', 'parar-texto-puro'], '03-parar-copia-sem-cifra', out)
    summary['stopPlaintext'] = stop or {'rc': rc, 'error': err}
    return done(None if (stop or {}).get('ok') else 'a linha do dump sem cifra não foi desligada')


def legado_restauracao():
    """Preparação da desativação do BIomie antigo: arquivo cifrado novo restaurado num MariaDB descartável e contado
    tabela a tabela (54_legado.py testar-restauracao). Começa nos minutos :05–:12 ou :35–:42, depois do
    materialize do legado (:00/:30), para o banco mudar o mínimo durante o dump. Nada é apagado."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-legado-restauracao'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'started': dt.datetime.now().isoformat(timespec='seconds')}
    deadline = time.time() + 6 * 3600
    while True:
        busy = night_slot()
        if not (5 <= dt.datetime.now().minute % 30 <= 12):
            busy.append('fora dos minutos :05–:12 / :35–:42')
        if not busy:
            break
        if time.time() > deadline:
            summary['stopped'] = 'sem horário livre em 6 h: ' + '; '.join(busy)
            break
        time.sleep(60)
    if 'stopped' not in summary:
        rc, test, err = remote(['ops/54_legado.py', 'testar-restauracao'], '01-teste-de-restauracao', out,
                               timeout=3 * 3600)
        summary['restoreTest'] = ({k: v for k, v in test.items() if k != 'archive'} if test else {'rc': rc, 'error': err})
        if test:
            summary['archive'] = {k: test['archive'].get(k) for k in ('file', 'bytes', 'sha256', 'tables', 'offsite')}
    summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


def legado_exclusao(expected_local, expected_offsite):
    """Exclusão das cópias SEM cifra do banco antigo (autorização do usuário de 04/11/2026, "depois das verificações
    de segurança"): guarda cifrada a cópia de 19/10 (último dia do antigo como sistema oficial) e só então apaga, se
    todos os portões do 54_legado.py passarem (arquivos cifrados conferidos local, fora e decifrados, restauração
    testada, marco conferido, dump das 03:00 desligado, backup do v2 em dia, quantidades iguais às informadas).
    Leve (sem janela): não usa a cópia de banco nem o Omie."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-legado-exclusao'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'started': dt.datetime.now().isoformat(timespec='seconds'),
               'expected': {'local': expected_local, 'offsite': expected_offsite}}
    rc, before, err = remote(['ops/54_legado.py', 'status'], '00-situacao-antes', out)
    summary['before'] = ({k: before.get(k) for k in ('legacyCron', 'legacyPlaintextDumps', 'offsite')} if before
                         else {'rc': rc, 'error': err})
    rc, marco, err = remote(['ops/54_legado.py', 'cifrar-marco'], '01-marco-19-10-cifrado', out, timeout=2 * 3600)
    summary['marco'] = ({k: marco.get(k) for k in ('file', 'bytes', 'sha256', 'source', 'roundTripSha256Ok',
                                                    'createTableStatements', 'dumpCompleted', 'offsite', 'ok',
                                                    'alreadyDone')}
                        if marco else {'rc': rc, 'error': err})
    if marco and marco.get('ok'):
        rc, deleted, err = remote(['ops/54_legado.py', 'excluir-texto-puro', str(expected_local), str(expected_offsite)],
                                  '02-exclusao-com-portoes', out, timeout=2 * 3600)
        summary['deletion'] = ({k: v for k, v in deleted.items() if k != 'verify'} if deleted
                               else {'rc': rc, 'error': err})
        if deleted and not deleted.get('ok'):
            summary['stopped'] = deleted.get('reason') or 'exclusão incompleta: ver 02-exclusao-com-portoes'
    else:
        summary['stopped'] = 'marco de 19/10 não conferido: nada foi apagado'
    rc, after, err = remote(['ops/54_legado.py', 'status'], '03-situacao-depois', out)
    summary['after'] = ({k: after.get(k) for k in ('legacyCron', 'legacyPlaintextDumps', 'encryptedArchives', 'offsite')}
                        if after else {'rc': rc, 'error': err})
    summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


def legado_passo1():
    """Desativação controlada do BIomie antigo, passo 1 (autorização de 04/11/2026): comenta as tarefas restantes
    do /etc/cron.d/biomie e do biomie-capacity (54_legado.py parar-tarefas; nada é apagado). Fora do expediente,
    nos minutos :05–:12 ou :35–:42 (depois do materialize das :00/:30). Portão de saída no dia seguinte:
    54_legado.py gravacoes <hora da parada>."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-legado-passo1'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'started': dt.datetime.now().isoformat(timespec='seconds')}
    deadline = time.time() + 6 * 3600
    while True:
        busy = night_slot()
        if not (5 <= dt.datetime.now().minute % 30 <= 12):
            busy.append('fora dos minutos :05–:12 / :35–:42')
        if not busy:
            break
        if time.time() > deadline:
            summary['stopped'] = 'sem horário livre em 6 h: ' + '; '.join(busy)
            break
        time.sleep(60)
    if 'stopped' not in summary:
        rc, before, err = remote(['ops/54_legado.py', 'status'], '00-situacao-antes', out)
        summary['before'] = (before or {}).get('legacyCron') or {'rc': rc, 'error': err}
        rc, stop, err = remote(['ops/54_legado.py', 'parar-tarefas'], '01-parar-tarefas', out)
        summary['stop'] = stop or {'rc': rc, 'error': err}
        rc, after, err = remote(['ops/54_legado.py', 'status'], '02-situacao-depois', out)
        summary['after'] = (after or {}).get('legacyCron') or {'rc': rc, 'error': err}
    summary['rollback'] = 'python ops/remote.py ops/54_legado.py desfazer-parar-tarefas'
    summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


def legado_passo2():
    """Desativação controlada do BIomie antigo, passo 2 (frase 1 de 04/11/2026, passos 1–6): para e tira do boot o
    biomie-python.service (127.0.0.1:8001) com 54_legado.py parar-python, só com os portões (passo 1 feito, nenhuma
    requisição em 24 h, nenhuma conexão, nenhuma rota do nginx, nenhum código do legado chamando). Nada é apagado.
    Mesma janela do passo 1 (fora do expediente, minutos :05–:12/:35–:42) e o prazo da noite (--ate), se houver."""
    import janela_testes
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-legado-passo2'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'started': dt.datetime.now().isoformat(timespec='seconds')}
    limit = janela_testes.night_limit()
    deadline = time.time() + 6 * 3600
    while True:
        if limit is not None and time.time() >= limit.timestamp():
            summary['stopped'] = f'prazo da noite ({limit:%d/%m %H:%M}) passou: fica para outra noite (nada mudou)'
            break
        busy = night_slot()
        if not (5 <= dt.datetime.now().minute % 30 <= 12):
            busy.append('fora dos minutos :05–:12 / :35–:42')
        if not busy:
            break
        if time.time() > deadline:
            summary['stopped'] = 'sem horário livre em 6 h: ' + '; '.join(busy)
            break
        time.sleep(60)
    if 'stopped' not in summary:
        rc, before, err = remote(['ops/54_legado.py', 'status'], '00-situacao-antes', out)
        summary['before'] = (before or {}).get('pythonService') or {'rc': rc, 'error': err}
        rc, stop, err = remote(['ops/54_legado.py', 'parar-python'], '01-parar-python', out)
        summary['stop'] = stop or {'rc': rc, 'error': err}
        if not (stop or {}).get('ok'):
            summary['stopped'] = (stop or {}).get('reason') or f'o passo 2 não terminou (rc={rc})'
        rc, after, err = remote(['ops/54_legado.py', 'status'], '02-situacao-depois', out)
        summary['after'] = (after or {}).get('pythonService') or {'rc': rc, 'error': err}
    summary['rollback'] = 'python ops/remote.py ops/54_legado.py desfazer-parar-python'
    summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


def smoke_retry(args, name, out):
    """Teste de navegador com UMA nova tentativa um minuto depois (túnel, rede); a 1ª fica registrada."""
    first = smoke(args, name, out)
    if first.get('ok'):
        return first
    time.sleep(60)
    second = smoke(args, name + '-2', out)
    second['firstAttempt'] = {k: first.get(k) for k in ('ok', 'failed', 'problems', 'error')}
    return second


def plano_night_ok(now=None):
    """Ativação do Plano de Voo só de madrugada, das 18:30 às 05:30: a análise diária do estoque roda às
    06:33, 07:03 e 07:35 e o expediente começa às 07:30."""
    t = (now or dt.datetime.now()).time()
    return t >= dt.time(18, 30) or t < dt.time(5, 30)


def plano(release):
    """Plano de Voo (0050) na homologação: cada passo pesado espera a janela; a produção não é tocada."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-plano-de-voo'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'release': release, 'started': dt.datetime.now().isoformat(timespec='seconds')}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    now = dt.datetime.now()
    if now.weekday() < 5 and dt.time(5, 0) <= now.time() < dt.time(18, 0):
        return done('a fila chegou fora da noite: a homologação fica para a próxima noite (nada foi feito)')
    problem = browser_problem()
    if problem:
        summary['browserPreCheck'] = problem
        return done('o navegador local não abre (Playwright/Chromium): nada foi feito na cópia; ' + problem[:200])
    rc, tests, err = remote(['ops/22_test_database.py', release] + WAIT, '01-testes-do-banco', out)
    summary['dbTests'] = {'rc': rc, 'allOk': (tests or {}).get('all_ok'), 'error': None if tests else err,
                          'migrations': (tests or {}).get('migrations_applied'),
                          'failures': {k: v.get('error') for k, v in (tests or {}).get('suites', {}).items()
                                       if not v.get('ok')}}
    if not (tests or {}).get('all_ok'):
        return done('suítes do banco não passaram: a homologação não sobe com teste falhando')
    remote(['ops/41_homolog.py', 'down'], '02a-homologacao-down', out)

    def stop(reason):
        """Saída antecipada depois de mexer na cópia: desliga a homologação ANTES de registrar. A cópia não pode
        ficar ligada: a fila seguinte e o portão do MAG AI (para se houver biomie-hml rodando) contam com ela
        desligada. Até 05/11 a subida que falhava saía sem o down."""
        rc, _, _ = remote(['ops/41_homolog.py', 'down'], '99-homologacao-down', out)
        summary['down'] = {'rc': rc, 'early': True}
        return done(reason)

    try:
        rc, refresh, err = remote(['ops/41_homolog.py', 'db-refresh'] + WAIT, '02b-copia-nova', out)
        summary['dbRefresh'] = refresh or {'rc': rc, 'error': err}
        if not refresh:
            return stop('a cópia nova da produção falhou')
        photo_before = photo(out, '02c-foto-da-copia-antes', copy=True)
        rc, up, err = remote(['ops/41_homolog.py', 'up', release] + WAIT, '02-homologacao-up', out)
        summary['up'] = ({k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up
                         else {'rc': rc, 'error': err})
        if not up:
            return stop('a homologação não subiu')
        # A 0050 só acrescenta: os números de antes (faturamento, sales_kpis, estoque, curvas) não podem mudar.
        summary['photoCopy'] = compare_photos(photo_before, photo(out, '02d-foto-da-copia-depois', copy=True))
        rc, check, err = remote(['ops/56_plano_voo_check.py'] + WAIT, '03-conferencia-e-tempos', out)
        summary['check'] = check or {'rc': rc, 'error': err}
        # Faturamento (0051): definição nova × anterior na cópia, linha a linha, e o tempo de cada uma. Release sem
        # a 0051 → skipped. Erro ou diferença → a validação recusa (plano_validation_ok).
        rc, fat, err = remote(['ops/57_faturamento_check.py'] + WAIT, '03b-faturamento-nova-x-anterior', out)
        summary['faturamento'] = fat or {'rc': rc, 'error': err}
        # Plano de Voo com gravação (cópia descartável), as cinco empresas, Gestor/Vendedor com e sem vínculo.
        summary['browser'] = smoke_retry(['--plano', '--plano-write', '--hml', '--shots',
                                          f'plano-{dt.date.today():%Y%m%d}'], '04-navegador-plano-de-voo', out)
        summary['regression'] = smoke_retry(['--hml'], '05-navegador-regressao', out)
        # Estoque (o gráfico da 2154e45 vem junto nesta release): mesmo teste do retorno das validações do estoque.
        summary['stock'] = smoke_retry(['--stock', '--stock-mode', 'on', '--curves-readonly', '--hml'],
                                       '05b-navegador-estoque', out)
        prod = production_release(out)
        summary['rollbackRelease'] = prod
        # A 0051 troca funções que já existem e a release anterior não a desfaz: o teste de retorno também passa
        # pelo 58 (devolve as funções de antes e apaga a linha da migração), como o retorno da produção faria.
        rc, undo, err = remote(['ops/58_desfazer_0051.py', release, prod, '--db=biomie_v2_hml'],
                               '05c-retorno-desfaz-0051', out)
        summary['rollbackUndo0051'] = undo or {'rc': rc, 'error': err}
        rc, back, err = remote(['ops/41_homolog.py', 'up', prod] + WAIT, '06-retorno-subida', out)
        summary['rollbackUp'] = ({k: back.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')}
                                 if back else {'rc': rc, 'error': err})
        if back:
            summary['rollbackRegression'] = smoke_retry(['--hml'], '07-retorno-navegador-regressao', out)
        rc, down, err = remote(['ops/41_homolog.py', 'down'], '08-homologacao-down', out)
        summary['down'] = {'rc': rc}
        return done()
    except BaseException as e:
        # Exceção no meio (tempo esgotado de um passo, rede, Ctrl-C): desliga a cópia, registra e repassa.
        try:
            rc, _, _ = remote(['ops/41_homolog.py', 'down'], '99-homologacao-down', out)
            summary['down'] = {'rc': rc, 'early': True}
        except BaseException as e2:  # noqa: BLE001
            summary['down'] = {'error': f'{type(e2).__name__}: {e2}'[:300]}
        done(f'exceção na homologação: {type(e).__name__}: {e}'[:500])
        raise


def plano_validation_ok(release):
    """A homologação do Plano de Voo de hoje (ou de ontem) para esta release passou inteira?"""
    s = None
    for day in (dt.date.today(), dt.date.today() - dt.timedelta(days=1)):
        try:
            s = json.loads((LOGS / 'noturno' / f'{day:%Y%m%d}-plano-de-voo' / 'resumo.json').read_text(encoding='utf-8'))
            break
        except (OSError, ValueError):
            continue
    if s is None:
        return False, ['sem resumo da homologação de hoje ou de ontem (ops/logs/noturno/<data>-plano-de-voo)']
    why = []
    if s.get('release') != release:
        why.append(f"a homologação foi da release {s.get('release')}")
    if s.get('stopped'):
        why.append('a homologação parou: ' + s['stopped'])
    if not (s.get('dbTests') or {}).get('allOk'):
        why.append('suítes do banco')
    photo_copy = s.get('photoCopy') or {}
    if not photo_copy.get('compared') or not photo_copy.get('equal'):
        why.append('foto da cópia antes × depois das migrações: ' + json.dumps(photo_copy.get('different') or
                                                                            photo_copy.get('error'), ensure_ascii=False)[:200])
    if not (s.get('check') or {}).get('ok'):
        why.append('conferência 56: ' + '; '.join((s.get('check') or {}).get('problems') or ['sem resultado']))
    fat = s.get('faturamento')
    if fat is not None and not fat.get('skipped') and fat.get('ok') is not True:
        why.append('conferência 57 (faturamento nova × anterior): '
                   + ('; '.join(fat.get('problems') or []) or str(fat.get('error') or 'sem resultado'))[:300])
    if fat is not None and not fat.get('skipped'):
        # Release que troca o faturamento: a foto tem de ter comparado justamente as partes do faturamento.
        missing = {'sales', 'kpis'} & set(photo_copy.get('notCompared') or [])
        if missing:
            why.append('foto da cópia sem as partes do faturamento: ' + ', '.join(sorted(missing)))
    undo = s.get('rollbackUndo0051')
    if undo is not None and undo.get('ok') is not True:
        why.append('retorno da 0051 na cópia (58): ' + str(undo.get('error') or 'sem resultado')[:200])
    for key in ('browser', 'regression', 'stock', 'rollbackRegression'):
        if not (s.get(key) or {}).get('ok'):
            why.append('navegador: ' + key)
    return not why, why


def undo_0051(out, release, previous, name):
    """A 0051 troca funções que já existem; a release anterior não a desfaz. O 58 devolve as funções de antes
    (ou responde skipped quando não há o que desfazer). Falha aqui não impede o retorno da release."""
    rc, undo, err = remote(['ops/58_desfazer_0051.py', release, previous, '--db=biomie_v2'], name, out)
    return undo or {'rc': rc, 'ok': False, 'error': err}


def rollback_after_activation(out, previous, reason, release=None):
    """Retorno depois de uma ativação que terminou mas falhou no navegador ou na foto: worker pausado, 0051
    desfeita se for o caso (58), release anterior (ela funciona com a 0050 aplicada: o 21 só aplica as migrações
    que conhece), worker retomado, navegador."""
    r = {'previous': previous}
    why = reason + ' retorno'
    remote(['ops/25_load.py', 'pause', why], '06a-retorno-worker-pausa', out)
    limit = time.time() + 20 * 60
    while True:
        state = worker_state(out, '06b-retorno-worker-pausado')
        if state.get('state') == 'PAUSED' and state.get('reason') == why:
            break
        if time.time() > limit:
            r['workerResumed'] = resume_worker(out, '06c-retorno-worker-retomado')
            r['ok'] = False
            r['error'] = 'o worker não pausou em 20 minutos: o retorno NÃO foi feito'
            return r
        time.sleep(20)
    if release:
        r['undo0051'] = undo_0051(out, release, previous, '06c2-retorno-desfaz-0051')
    rc, back, err = remote(['ops/21_activate_release.py', previous, '--start-worker'], '06d-retorno', out,
                           timeout=3 * 3600)
    r['run'] = back or {'rc': rc, 'error': err}
    r['workerResumed'] = resume_worker(out, '06e-retorno-worker-retomado')
    r['active'] = production_release(out)
    r['browser'] = smoke([], '06f-retorno-navegador', out)
    r['ok'] = rc == 0 and r['active'] == previous and (not release or r['undo0051'].get('ok') is True)
    return r


def ativar_plano(release, expected_previous=None, now_reason=None):
    """Ativação do Plano de Voo na produção, só depois da homologação do dia inteira (mesmos portões da
    ativação de 23/10 e 30/10). --anterior=<release>: só ativa se a produção estiver nessa release (a
    combinada com a outra fila). Só de madrugada (18:30–05:30), salvo --agora="motivo". Se a ativação
    falhar, ou terminar mas o navegador falhar na produção, volta sozinha para a release anterior."""
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-ativacao-plano-{release}'
    out.mkdir(parents=True, exist_ok=True)
    summary = {'release': release, 'expectedPrevious': expected_previous,
               'started': dt.datetime.now().isoformat(timespec='seconds')}
    if now_reason:
        summary['mode'] = {'agora': now_reason}

    def done(reason=None):
        if reason:
            summary['stopped'] = reason
        summary['finished'] = dt.datetime.now().isoformat(timespec='seconds')
        summary['rollback'] = ('python ops/remote.py ops/21_activate_release.py '
                               f"{summary.get('previous') or PRODUCTION_RELEASE} --start-worker")
        (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(summary, indent=1, ensure_ascii=False))

    def unexpected():
        return bool(expected_previous) and summary['previous'] != expected_previous

    ok, why = plano_validation_ok(release)
    summary['validation'] = {'ok': ok, 'problems': why}
    if not ok:
        return done('a homologação não passou inteira: ' + '; '.join(why))
    summary['previous'] = production_release(out)
    if summary['previous'] == release:
        return done('esta release já está ativa na produção: nada a fazer')
    if unexpected():
        return done(f"a release ativa é a {summary['previous']}, não a {expected_previous} combinada: nada mudou na produção")
    deadline = time.time() + 4 * 3600
    while True:
        if not now_reason and not plano_night_ok():
            return done('fora da madrugada (18:30–05:30): a ativação fica para a próxima noite; nada mudou na produção')
        busy = activation_slot()
        if not busy:
            break
        if time.time() > deadline:
            return done('sem horário livre para a ativação em 4 h: ' + '; '.join(busy))
        time.sleep(30)
    summary['slotAt'] = dt.datetime.now().isoformat(timespec='seconds')
    summary['previous'] = production_release(out)
    if summary['previous'] == release:
        return done('esta release já está ativa na produção: nada a fazer')
    if unexpected():
        return done(f"a release ativa é a {summary['previous']}, não a {expected_previous} combinada: nada mudou na produção")
    rc, ui, err = remote(['ops/51_ui_release_guard.py', release], '00a-preservacao-da-interface', out)
    summary['uiPreservation'] = ui if isinstance(ui, dict) else {'rc': rc, 'error': err}
    if rc != 0 or not isinstance(ui, dict) or ui.get('preserves_ui') is not True:
        return done('a preservação da interface não foi confirmada: nada mudou na produção')
    if ui.get('active') != summary['previous']:
        return done('a release da produção mudou durante a conferência: repita a ativação; nada mudou na produção')
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
    photo_before = photo(out, '00f-foto-antes')
    rc, act, err = remote(['ops/21_activate_release.py', release, '--start-worker'], '01-ativacao', out,
                          timeout=3 * 3600)
    summary['activation'] = act or {'rc': rc, 'error': err}
    if rc != 0:
        # A falha pode ter vindo depois das migrações: a 0051, se entrou, sai antes da release anterior voltar.
        summary['rollbackUndo0051'] = undo_0051(out, release, summary['previous'], '01q-retorno-desfaz-0051')
        rc2, back, err2 = remote(['ops/21_activate_release.py', summary['previous'], '--start-worker'],
                                 '01r-retorno', out, timeout=3 * 3600)
        summary['rollbackRun'] = back or {'rc': rc2, 'error': err2}
        if rc2 != 0:
            return done('ATENÇÃO: a ativação falhou e o retorno automático também; o worker continua pausado')
        summary['workerResumed'] = resume_worker(out, '01s-worker-retomado')
        summary['rollbackBrowser'] = smoke([], '01t-retorno-navegador', out)
        return done(f"a ativação falhou; a produção voltou sozinha para a {summary['previous']}")
    summary['active'] = production_release(out)
    summary['photo'] = compare_photos(photo_before, photo(out, '01a-foto-depois'))
    photo_s = summary['photo']
    if not (photo_s.get('compared') and photo_s.get('equal')
            and not ({'sales', 'kpis'} & set(photo_s.get('notCompared') or []))):
        # Números de antes mudaram (ou não deu para provar que não mudaram): volta já, com o worker ainda pausado.
        summary['autoRollback'] = rollback_after_activation(out, summary['previous'], reason, release)
        if summary['autoRollback'].get('ok'):
            return done(f"a foto antes × depois não saiu igual: a produção voltou sozinha para a {summary['previous']}")
        return done('ATENÇÃO: a foto antes × depois não saiu igual e o retorno automático não terminou: ver autoRollback')
    summary['workerResumed'] = resume_worker(out, '01b-worker-retomado')
    rc, check, err = remote(['ops/56_plano_voo_check.py', '--db=biomie_v2'] + WAIT, '02-conferencia-producao', out)
    summary['check'] = check or {'rc': rc, 'error': err}
    summary['browser'] = smoke_retry(['--plano', '--shots', f'producao-plano-{dt.date.today():%Y%m%d}'],
                                     '03-navegador-plano-producao', out)
    summary['regression'] = smoke_retry([], '04-navegador-regressao-producao', out)
    failed = [k for k in ('browser', 'regression') if not (summary.get(k) or {}).get('ok')]
    if failed:
        summary['autoRollback'] = rollback_after_activation(out, summary['previous'], reason, release)
        if summary['autoRollback'].get('ok'):
            return done(f"o navegador falhou na produção ({', '.join(failed)}): a produção voltou sozinha "
                        f"para a {summary['previous']}")
        return done(f"ATENÇÃO: o navegador falhou na produção ({', '.join(failed)}) e o retorno automático "
                    'não terminou: ver autoRollback')
    summary['workerAfter'] = {k: v for k, v in worker_state(out, '05-worker-depois').items()
                              if k in ('state', 'reason', 'at', 'commit')}
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
    # Horários da noite (combinado com o MAG AI, 06/11): --comecar-ate=HH:MM → se a vez na fila chegar depois,
    # a tarefa desiste sem fazer nada; --ate=HH:MM → nenhum passo pesado começa depois (a janela recusa e o
    # --esperar desiste no prazo); os fluxos saem pelo caminho normal, com a homologação desligada.
    import janela_testes
    started_at = dt.datetime.now(janela_testes.TZ)
    start_by = clock_option(sys.argv, '--comecar-ate', started_at)
    limit = clock_option(sys.argv, '--ate', started_at)
    if limit is not None:
        os.environ[janela_testes.LIMIT_ENV] = limit.isoformat()
    sys.argv = [a for a in sys.argv if not a.startswith(('--ate=', '--comecar-ate='))]
    task = sys.argv[1] if len(sys.argv) > 1 else ''
    queue_hours = 10 if task in ('plano', 'ativar-plano') else 6
    if start_by is not None:  # não segura lugar na fila além do --comecar-ate
        queue_hours = max(0.0, min(queue_hours, (start_by - started_at).total_seconds() / 3600))
    lock = night_lock(queue_hours) if task in ('matriz', 'sales-kpis', 'intel', 'intel-fornecedores', 'banco', 'trem',
                                    'ativar', 'intel-diaria-copia', 'intel-diaria-ativar', 'legado-backups',
                                    'matriz-teste', 'legado-restauracao', 'legado-exclusao',
                                    'legado-passo1', 'legado-passo2', 'plano', 'ativar-plano') else None
    if start_by is not None and dt.datetime.now(janela_testes.TZ) > start_by:
        raise SystemExit(f'{task}: a vez na fila chegou às {dt.datetime.now(janela_testes.TZ):%H:%M}, depois do '
                         f'--comecar-ate ({start_by:%d/%m %H:%M}); fica para outra noite (nada foi feito).')
    if limit is not None:
        print(f'[noturno] {task}: nenhum passo pesado começa depois de {limit:%d/%m %H:%M}', file=sys.stderr)
    if task in ('plano', 'ativar-plano'):
        args = [a for a in sys.argv[2:] if not a.startswith('--')]
        if not args or not args[0].isalnum():
            raise SystemExit(f'uso: {task} <release> [--anterior=<release>] [--agora="motivo"]')
        if task == 'plano':
            plano(args[0])
        else:
            previous = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--anterior=')), None)
            if previous is not None and not (previous.isalnum() and len(previous) == 12):
                raise SystemExit('--anterior precisa de uma release (12 caracteres)')
            now_reason = next((a.split('=', 1)[1].strip() for a in sys.argv if a.startswith('--agora=')), None)
            if now_reason is not None and len(now_reason) < 10:
                raise SystemExit('--agora precisa de um motivo (10 caracteres ou mais).')
            ativar_plano(args[0], expected_previous=previous, now_reason=now_reason)
    elif task == 'legado-exclusao':
        if len(sys.argv) < 4 or not (sys.argv[2].isdigit() and sys.argv[3].isdigit()):
            raise SystemExit('uso: legado-exclusao <quantidade no servidor> <quantidade na Hostinger>')
        legado_exclusao(int(sys.argv[2]), int(sys.argv[3]))
    elif task == 'legado-passo1':
        legado_passo1()
    elif task == 'legado-passo2':
        legado_passo2()
    elif task == 'legado-backups':
        legado_backups()
    elif task == 'legado-restauracao':
        legado_restauracao()
    elif task == 'matriz-teste':
        if len(sys.argv) < 3:
            raise SystemExit('uso: matriz-teste <release com rastreio> [rodadas]')
        matriz_teste(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 3)
    elif task == 'intel-diaria-copia':
        intel_diaria_copia(sys.argv[2] if len(sys.argv) > 2 else None)
    elif task == 'intel-diaria-ativar':
        intel_diaria_ativar()
    elif task == 'intel':
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
