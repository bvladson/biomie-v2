"""Trabalhos noturnos da HOMOLOGAÇÃO, para o Agendador de Tarefas do Windows (não dependem de uma
sessão do Claude aberta). Cada passo pesado passa pela janela de testes (--esperar) e tudo fica em
ops/logs/noturno/<data>-<tarefa>/ (um arquivo por passo + resumo.json). Nada aqui muda a produção.

    python ops/noturno.py matriz [release] [rodadas]   # teste controlado da correção da MAG Matriz
    python ops/noturno.py sales-kpis                   # diagnóstico de sales_kpis na cópia

matriz (parecer de 26/10/2026): base da produção (72 h) → até N rodadas do tx-probe (cada uma espera
uma janela sem uso real da chave pela produção) → produção nas últimas horas. A série PARA na primeira
rodada encerrada por segurança ou com 2 ou mais respostas "já existe uma requisição".
"""
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
BASE = pathlib.Path(__file__).resolve().parent.parent
# --teste: não espera a janela (no expediente a janela recusa na hora): confere só o encanamento.
WAIT = [] if '--teste' in sys.argv else ['--esperar']
LOGS = BASE / 'ops' / 'logs'


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


def sales_kpis():
    out = LOGS / 'noturno' / f'{dt.date.today():%Y%m%d}-sales-kpis'
    out.mkdir(parents=True, exist_ok=True)
    rc, data, err = remote(['ops/45_sales_kpis_diag.py', '--planos'] + WAIT, '01-diagnostico', out)
    summary = {'rc': rc, 'error': None if data else err,
               'warm_ms': {k: v['ms'][-1] for k, v in (data or {}).get('measures', {}).items()},
               'rows': {k: v['rows'] for k, v in (data or {}).get('measures', {}).items()},
               'plansFile': (data or {}).get('plans', {}).get('file')}
    (out / 'resumo.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, indent=1, ensure_ascii=False))


if __name__ == '__main__':
    sys.argv = [a for a in sys.argv if a != '--teste']
    task = sys.argv[1] if len(sys.argv) > 1 else ''
    if task == 'matriz':
        release = sys.argv[2] if len(sys.argv) > 2 else 'ba4ee4b03c40'
        rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
        matriz(release, rounds)
    elif task == 'sales-kpis':
        sales_kpis()
    else:
        raise SystemExit(__doc__)
