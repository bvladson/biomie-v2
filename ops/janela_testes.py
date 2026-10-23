"""Janela dos testes pesados da homologação (parecer do monitoramento 1/3, 23/10/2026, item 3).

Testes pesados — cópia do banco, build e subida da homologação, motor de inteligência, carga de
movimentações, suítes de banco (22_test_database) e testes de navegador na homologação — só rodam:
- fora do expediente: dias úteis antes das 07:30 ou a partir das 18:30; sábado a partir das 12:30;
  domingo livre (horário de Brasília);
- longe das cargas recorrentes do worker (:21 e :51): só começam nos minutos :00–:12 e :30–:42;
- sem leitura de estoque em andamento ou na fila (07:40, 12:40, 17:40 e fechamento 23:50);
- com o servidor folgado (carga de 1 minuto abaixo de 1,0 nas 2 CPUs).
Fora disso o comando é recusado. Exceção só com --fora-da-janela="motivo" (o motivo vai para a saída).
Com --esperar, aguarda a janela abrir (checa a cada 60 s, até 3 h).

Os limites de recursos ficam na própria homologação (41_homolog.py): builds num builder com 1 CPU e
3 GB, site da homologação com 0,5 CPU, motor com 0,5 CPU e 512 MB.
"""
import datetime as dt
import pathlib
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

try:
    TZ = ZoneInfo('America/Sao_Paulo')
except Exception:  # Windows sem a base de fusos: Brasília é UTC−3 fixo (sem horário de verão desde 2019)
    TZ = dt.timezone(dt.timedelta(hours=-3), 'BRT')
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
       '-i', str(pathlib.Path.home() / '.ssh/hostinger_srv1851839_ed25519'), 'root@179.197.238.57']
HEAVY_HOMOLOG = {'db-refresh', 'up', 'intel-run', 'movements-load'}
# Duas linhas: carga de 1 minuto e leituras de estoque abertas (só leitura).
PROBE = ("cut -d' ' -f1 /proc/loadavg; docker compose --env-file /opt/biomie-v2/shared/stack.env "
         "-f /opt/biomie-v2/compose.yml exec -T db psql -X -U postgres -d biomie_v2 -At -c "
         "\"select count(*) from private.stock_readings where status in ('queued','running')\"")


def is_heavy(script: pathlib.Path, args: list[str]) -> bool:
    """Operações pesadas: subcomandos pesados da homologação, suítes de banco e scripts avulsos que
    consultam a cópia da homologação."""
    name = script.name
    if name == '41_homolog.py':
        return bool(args) and args[0] in HEAVY_HOMOLOG
    if name == '22_test_database.py':
        return True
    if name == '29_smoke.py':
        return '--hml' in args
    try:
        return 'biomie_v2_hml' in script.read_text(encoding='utf-8')
    except OSError:
        return False


def business_hours(now: dt.datetime) -> bool:
    t = now.time()
    if now.weekday() < 5:
        return dt.time(7, 30) <= t < dt.time(18, 30)
    if now.weekday() == 5:
        return dt.time(7, 30) <= t < dt.time(12, 30)
    return False


def reasons(now: dt.datetime | None = None, probe: str | None = None) -> list[str]:
    """Motivos para NÃO começar agora (lista vazia = pode começar)."""
    now = now or dt.datetime.now(TZ)
    out = []
    if business_hours(now):
        out.append(f'expediente ({now:%a %H:%M}); testes pesados só fora do expediente')
    if now.minute % 30 > 12:
        out.append(f'minuto :{now.minute:02d} perto das cargas :21/:51 (começar entre :00–:12 ou :30–:42)')
    if probe is None:
        p = subprocess.run(SSH + [PROBE], capture_output=True, text=True, timeout=60)
        probe = p.stdout.strip() if p.returncode == 0 else ''
    try:
        load, readings = probe.split()
        if float(load) >= 1.0:
            out.append(f'servidor carregado (load1 {load})')
        if int(readings) > 0:
            out.append(f'leitura de estoque em andamento ou na fila ({readings})')
    except ValueError:
        out.append('não consegui medir a carga do servidor e as leituras de estoque')
    return out


def guard(script: pathlib.Path, args: list[str]) -> list[str]:
    """Aplica a janela; devolve os argumentos sem as opções da janela. Sai com erro se recusar."""
    override = next((a for a in args if a.startswith('--fora-da-janela=')), None)
    wait = '--esperar' in args
    clean = [a for a in args if a != '--esperar' and not a.startswith('--fora-da-janela=')]
    if not is_heavy(script, clean):
        return clean
    if override:
        reason = override.split('=', 1)[1].strip()
        if len(reason) < 10:
            raise SystemExit('--fora-da-janela precisa de um motivo (10 caracteres ou mais).')
        print(f'[janela] EXCEÇÃO autorizada: {reason}', file=sys.stderr)
        return clean
    deadline = time.time() + 3 * 3600
    while True:
        blocked = reasons()
        if not blocked:
            print(f'[janela] ok: {dt.datetime.now(TZ):%d/%m %H:%M}', file=sys.stderr)
            return clean
        if not wait or time.time() > deadline:
            raise SystemExit('[janela] teste pesado recusado agora: ' + '; '.join(blocked)
                             + '. Use --esperar ou --fora-da-janela="motivo".')
        time.sleep(60)
