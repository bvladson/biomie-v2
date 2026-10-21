"""Cargas do Omie no BIomie antigo (cron do PHP): consultar, desligar e religar.

    python ops/remote.py ops/38_legacy_syncs.py status
    python ops/remote.py ops/38_legacy_syncs.py off     # cópia de segurança + comenta as 4 linhas
    python ops/remote.py ops/38_legacy_syncs.py on      # restaura a cópia salva pelo "off"

Desliga só o que fala com o Omie ou alerta sobre ele: worker.sh (webhooks e sincronização delta),
sync_commercial.sh, sync_finance.sh e ops_sentinel.sh (alertaria "fora do prazo" sem as cargas).
PHP, banco do legado, materialize.sh e o endereço de webhook continuam como estão: os eventos do
Omie seguem guardados na caixa de entrada do legado e, num retorno, a fila os processa ao religar.
Cada execução já iniciada termina sozinha; nada é interrompido à força.
"""
import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

CRON = pathlib.Path('/etc/cron.d/biomie')
BACKUPS = pathlib.Path('/root/backups')
TARGETS = ('worker.sh', 'sync_commercial.sh', 'sync_finance.sh', 'quote_agenda_scan.sh',
           'finance_future_receivables.sh', 'ops_sentinel.sh')
KEEP = ('materialize.sh',)
MARK = '#OFF-biomie-v2 '
LOGS = pathlib.Path('/var/www/biomie/live/storage/logs/cron')
LOG_NAME = {'finance_future_receivables.sh': 'finance_future.log'}
RUNNING = 'cron/worker.php|cron/sync_all_companies.php|bin/quote_agenda_scan.php|bin/ops_sentinel.php'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def lines_state(text):
    state = {}
    for name in TARGETS + KEEP:
        hits = [line for line in text.splitlines() if name in line]
        if not hits:
            state[name] = 'ausente'
        elif all(line.startswith(MARK) for line in hits):
            state[name] = 'desligado'
        elif all(not line.lstrip().startswith('#') for line in hits):
            state[name] = 'ligado'
        else:
            state[name] = 'misto'
    return state


def last_finish(script):
    log = LOGS / LOG_NAME.get(script, script.replace('.sh', '') + '.log')
    if not log.exists():
        return None
    with log.open('rb') as handle:
        handle.seek(max(0, log.stat().st_size - 200_000))
        tail = handle.read().decode('utf-8', 'replace').splitlines()
    marks = [line for line in tail if line.startswith('[') and (' finish' in line or ': fim ' in line)]
    return marks[-1][1:20] if marks else None


def running():
    p = subprocess.run(['pgrep', '-af', RUNNING], capture_output=True, text=True)
    return [line.split(' ', 1)[1][:120] for line in p.stdout.splitlines() if 'pgrep' not in line]


def status():
    text = CRON.read_text()
    return {'cron': str(CRON), 'sha': sha(CRON), 'linhas': lines_state(text),
            'ultima_execucao': {s: last_finish(s) for s in TARGETS + KEEP},
            'em_execucao': running(),
            'copias': sorted(p.name for p in BACKUPS.glob('cron.d-biomie-*'))[-3:] if BACKUPS.exists() else []}


def write_atomic(text):
    tmp = CRON.with_name('.biomie-tmp')  # nome com ponto: o cron ignora este arquivo
    tmp.write_text(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, CRON)


command = sys.argv[1] if len(sys.argv) > 1 else 'status'
if command == 'status':
    print(json.dumps(status(), indent=1, ensure_ascii=False))
elif command == 'off':
    text = CRON.read_text()
    before = lines_state(text)
    if all(before[t] == 'desligado' for t in TARGETS):
        print(json.dumps({'ok': True, 'ja_estava': 'desligado', **status()}, indent=1, ensure_ascii=False))
        raise SystemExit(0)
    if any(before[t] in ('ausente', 'misto') for t in TARGETS):
        raise SystemExit(f'cron com formato inesperado, nada alterado: {before}')
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = BACKUPS / f"cron.d-biomie-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
    backup.write_text(text)
    os.chmod(backup, 0o600)
    new = '\n'.join(MARK + line if any(t in line for t in TARGETS) and not line.lstrip().startswith('#') else line
                    for line in text.splitlines()) + ('\n' if text.endswith('\n') else '')
    write_atomic(new)
    after = lines_state(CRON.read_text())
    if not all(after[t] == 'desligado' for t in TARGETS) or any(after[k] != 'ligado' for k in KEEP):
        write_atomic(text)
        raise SystemExit(f'conferência falhou, arquivo original restaurado: {after}')
    # Execuções já iniciadas terminam sozinhas (no máximo alguns minutos).
    deadline = time.time() + 600
    while running() and time.time() < deadline:
        time.sleep(15)
    print(json.dumps({'ok': True, 'copia': str(backup), 'sha_copia': sha(backup), **status()},
                     indent=1, ensure_ascii=False))
elif command == 'on':
    copies = sorted(BACKUPS.glob('cron.d-biomie-*')) if BACKUPS.exists() else []
    if not copies:
        raise SystemExit('nenhuma cópia de segurança encontrada em /root/backups')
    original = copies[-1].read_text()
    if not all(lines_state(original)[t] == 'ligado' for t in TARGETS):
        raise SystemExit(f'a cópia {copies[-1].name} não tem as cargas ligadas; nada alterado')
    write_atomic(original)
    print(json.dumps({'ok': True, 'restaurado_de': copies[-1].name, **status()}, indent=1, ensure_ascii=False))
else:
    raise SystemExit(__doc__)
