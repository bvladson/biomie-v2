"""Ritmo das cargas do Omie na PRODUÇÃO (SÓ LEITURA): base para avaliar a correção da MAG Matriz.

    python ops/remote.py ops/44_omie_ritmo.py [horas=72]

- duração das cargas de contas a receber e baixas por empresa (mediana, p90, máximo) e quantas passaram
  de 15 min (as pausas de 30 min do circuito aparecem aqui);
- respostas "já existe uma requisição" e pausas do circuito no log do worker, por hora;
- cargas vazias (received = 0) por empresa e entidade: custo estimado da espera de 12 s depois de período
  vazio (cada mês sem registros = 12 s a mais).
Lê o banco da produção e o arquivo de log do worker; não muda nada.
"""
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys

HOURS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 72
BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]


def psql(sql):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At',
                                  '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True, timeout=300)
    if p.returncode:
        raise SystemExit(p.stderr[-800:])
    return ' '.join(line for line in p.stdout.splitlines() if line not in ('BEGIN', 'COMMIT'))


runs = json.loads(psql(f"""begin read only;
select coalesce(json_agg(t order by t.company, t.entity), '[]') from (
  select c.slug as company, r.entity, count(*) as runs,
    count(*) filter (where r.status = 'FAILED') as failed,
    round(percentile_cont(0.5) within group (order by extract(epoch from r.finished_at - r.started_at))::numeric, 1) as p50_s,
    round(percentile_cont(0.9) within group (order by extract(epoch from r.finished_at - r.started_at))::numeric, 1) as p90_s,
    round(max(extract(epoch from r.finished_at - r.started_at))::numeric, 1) as max_s,
    count(*) filter (where r.finished_at - r.started_at > interval '15 minutes') as over_15min,
    count(*) filter (where r.received = 0) as empty_runs
  from public.integration_sync_runs r join public.companies c on c.id = r.company_id
  where r.entity in ('invoices', 'orders', 'receivables', 'settlements') and r.finished_at is not null
    and r.started_at >= now() - interval '{HOURS} hours'
  group by 1, 2) t;
commit;"""))

# Log do worker direto do arquivo json-file (docker logs devolve só trechos antigos neste servidor).
path = subprocess.run(['docker', 'inspect', '--format', '{{.LogPath}}', 'biomie-v2-worker-1'], capture_output=True,
                      text=True).stdout.strip()
since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=HOURS)).strftime('%Y-%m-%dT%H:%M:%S')
busy, pauses, busy_calls = {}, {}, {}
first_seen = None
for name in sorted([f for f in os.listdir(os.path.dirname(path)) if f.startswith(os.path.basename(path))],
                   key=lambda f: os.path.getmtime(os.path.join(os.path.dirname(path), f))) if path else []:
    with open(os.path.join(os.path.dirname(path), name), encoding='utf-8', errors='replace') as handle:
        for raw in handle:
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            stamp, text = rec.get('time', ''), rec.get('log', '')
            if stamp[:19] < since:
                continue
            first_seen = first_seen or stamp[:19]
            hour = stamp[:13]
            if 'Omie ainda processa outra' in text:
                busy[hour] = busy.get(hour, 0) + 1
                m = re.search(r'call=(\S+)', text)
                if m:
                    busy_calls[m.group(1)] = busy_calls.get(m.group(1), 0) + 1
            if 'bloqueado temporariamente' in text:
                pauses[hour] = pauses.get(hour, 0) + 1

empty = {f"{r['company']}:{r['entity']}": r['empty_runs'] for r in runs if r['entity'] in ('receivables', 'settlements')}
print(json.dumps({
    'hours': HOURS, 'logFrom': first_seen,
    'runs': runs,
    'busyAnswers': {'total': sum(busy.values()), 'byCall': busy_calls, 'byHourUtc': busy},
    'circuitPauseLines': {'total': sum(pauses.values()), 'byHourUtc': pauses},
    'emptyRunsReceivablesSettlements': empty,
}, indent=1, ensure_ascii=False))
