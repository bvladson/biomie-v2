"""Trabalhos noturnos da HOMOLOGAÇÃO, para o Agendador de Tarefas do Windows (não dependem de uma
sessão do Claude aberta). Cada passo pesado passa pela janela de testes (--esperar) e tudo fica em
ops/logs/noturno/<data>-<tarefa>/ (um arquivo por passo + resumo.json). Nada aqui muda a produção.

    python ops/noturno.py matriz [release] [rodadas]   # teste controlado da correção da MAG Matriz
    python ops/noturno.py sales-kpis [release]         # sales_kpis: diagnóstico, testes do banco e comparação
    python ops/noturno.py intel [release]              # Inteligência (fases 1–5) na homologação
    python ops/noturno.py intel-fornecedores <release> # idem, com fornecedores e prazos (0048/0049)

Uma tarefa por vez: cada uma espera a anterior terminar (trava em ops/logs/noturno/.trava, solta
sozinha quando o processo acaba, mesmo se cair).

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


def night_lock(hours=5):
    """Trava exclusiva entre as tarefas noturnas (o sistema solta quando o processo termina)."""
    path = LOGS / 'noturno' / '.trava'
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, 'a+')
    deadline = time.time() + hours * 3600
    while True:
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return handle
        except OSError:
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
    if suppliers:
        remote(['ops/41_homolog.py', 'down'], '02a-homologacao-down', out)
        rc, refresh, err = remote(['ops/41_homolog.py', 'db-refresh'] + WAIT, '02b-copia-nova', out)
        summary['dbRefresh'] = refresh or {'rc': rc, 'error': err}
        if not refresh:
            return done('a cópia nova da produção falhou')
    rc, up, err = remote(['ops/41_homolog.py', 'up', release] + WAIT, '02-homologacao-up', out)
    summary['up'] = {k: up.get(k) for k in ('migrations', 'login_page', 'seconds', 'image')} if up else {'rc': rc, 'error': err}
    if not up:
        return done('a homologação não subiu')
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
                          'steps': [{'name': s.get('name'), 'ok': s.get('ok'), 'error': s.get('error')}
                                    for s in (browser or {}).get('steps', [])],
                          'problems': (browser or {}).get('problems'),
                          'error': None if browser else p.stderr.strip()[-600:]}
    rc, down, err = remote(['ops/41_homolog.py', 'down'], '08-homologacao-down', out)
    summary['down'] = {'rc': rc}
    return done()


if __name__ == '__main__':
    sys.argv = [a for a in sys.argv if a != '--teste']
    task = sys.argv[1] if len(sys.argv) > 1 else ''
    lock = night_lock() if task in ('matriz', 'sales-kpis', 'intel', 'intel-fornecedores') else None
    if task == 'intel':
        intel(sys.argv[2] if len(sys.argv) > 2 else INTEL_RELEASE)
    elif task == 'intel-fornecedores':
        if len(sys.argv) < 3:
            raise SystemExit('uso: intel-fornecedores <release>')
        intel(sys.argv[2], suppliers=True)
    elif task == 'matriz':
        release = sys.argv[2] if len(sys.argv) > 2 else 'ba4ee4b03c40'
        rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
        matriz(release, rounds)
    elif task == 'sales-kpis':
        sales_kpis(sys.argv[2] if len(sys.argv) > 2 else SALES_KPIS_RELEASE)
    else:
        raise SystemExit(__doc__)
