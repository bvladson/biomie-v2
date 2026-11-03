"""Teste da ANÁLISE DIÁRIA na cópia da homologação (biomie_v2_hml), com a rotina instalada no servidor
(/opt/biomie-v2/bin/intel_diaria.py) e um cron de verdade. A produção não é tocada: o alvo é sempre a cópia.

    python ops/remote.py ops/53_intel_diaria_teste.py --esperar

Pré-requisitos: cópia nova da produção e homologação no ar (41_homolog db-refresh + up) e a rotina enviada.
Roteiro (cada passo vira uma conferência com ok/detalhe no relatório):
 1. a cópia nasce com a inteligência DESLIGADA (como a produção) → a rotina não roda o motor;
 2. liga na cópia e põe um cron TEMPORÁRIO para daqui a 2 minutos → o cron dispara a rotina, que publica
    (trigger schedule) e grava diagnósticos, recomendações, a foto do dia e o histórico das curvas nas
    5 empresas, com capital do motor = posições;
 3. rodar de novo no mesmo dia → nova execução publicada, mas a foto do dia, o histórico das curvas do dia,
    os produtos analisados e os alertas abertos ficam iguais (nada duplicado);
 4. "--se-faltar" com a análise de hoje já publicada → não roda;
 5. trava ocupada → não roda ("em andamento");
 6. motor derrubado no meio → falha registrada, resultados dela apagados, análise em uso continua a anterior;
 7. execução "parada" sem processo do motor → a rotina marca como falha e publica a nova;
 8. verificação → "ok"; desligada → a rotina e a verificação não rodam nada;
 9. a cópia não escreve alerta no log do monitor da produção.
O cron temporário é apagado no fim, mesmo com erro. A cópia termina com a inteligência desligada.
"""
import datetime as dt
import fcntl
import hashlib
import json
import pathlib
import subprocess
import time

BASE = pathlib.Path('/opt/biomie-v2')
RUNNER = BASE / 'bin' / 'intel_diaria.py'
DB = 'biomie_v2_hml'
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared' / 'stack.env'), '-f', str(BASE / 'compose.yml')]
TEST_CRON = pathlib.Path('/etc/cron.d/biomie-v2-intel-copia-teste')
STATUS = BASE / 'hml' / 'intel-diaria.json'
HEALTH_LOG = pathlib.Path('/var/log/biomie-v2-health.log')
LOCK = pathlib.Path('/run/lock/biomie-v2-intel.lock')
checks = []
timeline = []


def check(name, ok, **detail):
    checks.append({'name': name, 'ok': bool(ok), **detail})


def mark(step, **info):
    timeline.append({'at': dt.datetime.now().isoformat(timespec='seconds'), 'step': step, **info})


def psql(sql):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At',
                                  '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=300)
    if p.returncode:
        raise SystemExit('psql: ' + (p.stderr or p.stdout)[-800:])
    return p.stdout.strip()


def psql_json(sql):
    lines = [line for line in psql(sql).splitlines() if line.startswith(('{', '['))]
    return json.loads(lines[-1]) if lines else None


def runner(*args):
    p = subprocess.run(['python3', str(RUNNER), '--alvo=copia', *args], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=3600)
    final = None
    for line in p.stdout.splitlines():
        if line.startswith('{'):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('event') == 'fim':
                final = event.get('situacao')
    mark('rotina ' + (' '.join(args) or 'normal'), exit=p.returncode, resultado=(final or {}).get('resultado'),
         runId=(final or {}).get('runId'), motivo=(final or {}).get('motivo'))
    return p.returncode, final or {}, p.stderr[-800:]


STATE_SQL = """
with cur as (select ic.company_id, ic.run_id from private.intel_current ic),
co as (select c.id, c.slug from public.companies c join private.stock_current sc on sc.company_id = c.id
       where not c.is_demo),
last as (select company_id, max(day) as day from private.stock_snapshots group by 1)
select json_build_object(
  'enabled', (select enabled from private.intel_settings where id),
  'runs', (select count(*) from private.intel_runs),
  'alertsOpen', (select count(*) from private.intel_alerts where status = 'open'),
  'alertsOpenDuplicates', (select count(*) from (select 1 from private.intel_alerts where status = 'open'
                           group by company_id, omie_product_id, kind having count(*) > 1) d),
  'companies', (select coalesce(json_agg(json_build_object('company', co.slug, 'run', cur.run_id,
      'metrics', (select count(*) from private.intel_product_metrics m where m.run_id = cur.run_id
                  and m.company_id = co.id),
      'snapshotDay', last.day,
      'snapshotRowsForDay', (select count(*) from private.stock_snapshots s where s.company_id = co.id
                             and s.day = last.day),
      'snapshotTotals', (select md5(s.totals::text) from private.stock_snapshots s where s.company_id = co.id
                         and s.day = last.day),
      'curveHistoryForDay', (select count(*) from private.stock_curve_history h where h.company_id = co.id
                             and h.day = last.day)) order by co.slug), '[]')
    from co left join cur on cur.company_id = co.id left join last on last.company_id = co.id));"""


def state():
    return psql_json(STATE_SQL)


def run_row(run_id):
    if not run_id:
        return {}
    return psql_json(f"""select json_build_object('status', r.status, 'trigger', r.trigger, 'error', r.error,
        'metrics', (select count(*) from private.intel_product_metrics m where m.run_id = r.id))
        from private.intel_runs r where r.id = '{run_id}'::uuid;""") or {}


def warn_lines():
    if not HEALTH_LOG.exists():
        return 0
    return sum(1 for line in HEALTH_LOG.read_text(errors='replace').splitlines() if 'inteligencia diaria' in line)


def set_enabled(value):
    psql(f"select stock_internal.intel_set_enabled({'true' if value else 'false'});")


def wait_cron(target, before_at):
    """Espera a rotina disparada pelo cron gravar a situação (até 6 min depois do horário marcado)."""
    limit = target + dt.timedelta(minutes=6)
    while dt.datetime.now() < limit:
        try:
            s = json.loads(STATUS.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            s = {}
        if s.get('at') and s.get('at') != before_at and s.get('fim'):
            return s
        time.sleep(10)
    return None


def main():
    report = {'started': dt.datetime.now().isoformat(timespec='seconds')}
    if not RUNNER.exists():
        raise SystemExit(f'rotina ausente: {RUNNER}')
    report['runnerSha256'] = hashlib.sha256(RUNNER.read_bytes()).hexdigest()
    warn_before = warn_lines()
    base = state()
    report['before'] = base
    check('1 cópia nasce com a inteligência desligada (como a produção)', base['enabled'] is False)
    rc, s, err = runner()
    after = state()
    check('1 desligada: a rotina não roda o motor', s.get('resultado') == 'desligada' and after['runs'] == base['runs'],
          resultado=s.get('resultado'), stderr=err or None)

    set_enabled(True)
    mark('inteligência ligada na cópia')
    now = dt.datetime.now()
    target = (now + dt.timedelta(minutes=3 if now.second > 40 else 2)).replace(second=0, microsecond=0)
    try:
        before_at = json.loads(STATUS.read_text(encoding='utf-8')).get('at') if STATUS.exists() else None
    except ValueError:
        before_at = None
    try:
        TEST_CRON.write_text('# TESTE temporário do ops/53_intel_diaria_teste.py (apagado no fim do teste)\n'
                             'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
                             'MAILTO=""\n'
                             f'{target.minute} {target.hour} {target.day} {target.month} * root /usr/bin/python3 '
                             f'{RUNNER} --alvo=copia >/dev/null 2>>{BASE}/hml/intel-diaria.log\n')
        TEST_CRON.chmod(0o644)
        mark('cron temporário instalado', para=target.strftime('%H:%M'))
        s1 = wait_cron(target, before_at)
    finally:
        TEST_CRON.unlink(missing_ok=True)
        mark('cron temporário apagado')
    s1 = s1 or {}
    fired = s1.get('at', '')
    report['cron'] = {'target': target.isoformat(), 'firedAt': fired, 'resultado': s1.get('resultado'),
                      'runId': s1.get('runId'), 'motor': s1.get('motor'), 'imagem': s1.get('imagem')}
    fired_local = None
    try:
        fired_local = dt.datetime.fromisoformat(fired).astimezone().replace(tzinfo=None)
    except ValueError:
        pass
    check('2 o cron do servidor disparou a rotina no horário marcado',
          fired_local is not None and target <= fired_local < target + dt.timedelta(minutes=1),
          alvo=target.strftime('%H:%M:%S'), disparo=fired)
    run1 = run_row(s1.get('runId'))
    conf = s1.get('conferencia') or {}
    companies = conf.get('companies') or []
    check('2 publicada pela agenda (trigger schedule)', s1.get('resultado') == 'publicada'
          and run1.get('status') == 'published' and run1.get('trigger') == 'schedule', run=run1)
    check('2 as 5 empresas na mesma execução', len(companies) == 5 and all(c.get('current') for c in companies),
          empresas=[c.get('company') for c in companies])
    check('2 diagnósticos gravados', sum(c.get('withDiagnosis') or 0 for c in companies) > 0,
          porEmpresa={c.get('company'): c.get('withDiagnosis') for c in companies})
    check('2 recomendações gravadas', sum(c.get('withRecommendation') or 0 for c in companies) > 0,
          porEmpresa={c.get('company'): c.get('withRecommendation') for c in companies})
    check('2 foto do dia gravada nas 5 empresas', len(companies) == 5 and all(c.get('snapshotDay') for c in companies),
          dias={c.get('company'): c.get('snapshotDay') for c in companies})
    # Histórico = uma linha por produto cuja curva mudou desde a última foto (e a primeira de cada produto).
    check('2 histórico das curvas gravado no dia da foto', all(c.get('snapshotDay') for c in companies)
          and sum(c.get('curveHistoryRows') or 0 for c in companies) > 0,
          linhasNoDia={c.get('company'): c.get('curveHistoryRows') for c in companies},
          diasComHistorico=conf.get('curveHistoryDays'), diasComFoto=conf.get('snapshotDays'))
    check('2 capital do motor = posições (regra do 43) e conferência sem problema', s1.get('consistente') is True,
          problemas=s1.get('problemas'),
          capital={c.get('company'): [c.get('capitalEngine'), c.get('capitalPositions')] for c in companies})
    state1 = state()

    rc, s2, err = runner()
    state2 = state()
    run2 = run_row(s2.get('runId'))
    same = lambda key: {c['company']: c[key] for c in state1['companies']} == {c['company']: c[key] for c in state2['companies']}  # noqa: E731
    check('3 rodar de novo no mesmo dia publica outra execução', s2.get('resultado') == 'publicada'
          and run2.get('status') == 'published' and s2.get('runId') != s1.get('runId'))
    check('3 foto do dia: uma linha por empresa e os mesmos totais',
          all(c['snapshotRowsForDay'] == 1 for c in state2['companies']) and same('snapshotTotals') and same('snapshotDay'))
    check('3 histórico das curvas do dia igual (substituído, não duplicado)', same('curveHistoryForDay'),
          antes={c['company']: c['curveHistoryForDay'] for c in state1['companies']},
          depois={c['company']: c['curveHistoryForDay'] for c in state2['companies']})
    check('3 mesmos produtos analisados por empresa', same('metrics'))
    check('3 alertas abertos iguais e sem duplicidade', state1['alertsOpen'] == state2['alertsOpen']
          and state2['alertsOpenDuplicates'] == 0, antes=state1['alertsOpen'], depois=state2['alertsOpen'])
    check('3 análise em uso = a nova execução', all(c['run'] == s2.get('runId') for c in state2['companies']))

    runs_before = state2['runs']
    rc, s3, err = runner('--se-faltar')
    check('4 nova tentativa com a análise de hoje já publicada não roda', s3.get('resultado') == 'ja_publicada'
          and state()['runs'] == runs_before, resultado=s3.get('resultado'))

    with open(LOCK, 'a+') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        rc, s4, err = runner()
        fcntl.flock(handle, fcntl.LOCK_UN)
    check('5 trava ocupada: não roda', s4.get('resultado') == 'em_andamento' and state()['runs'] == runs_before,
          resultado=s4.get('resultado'), motivo=s4.get('motivo'))

    rc, s5, err = runner('--teste-falha')
    run5 = run_row(s5.get('runId'))
    state5 = state()
    check('6 motor derrubado no meio: falha registrada', s5.get('resultado') == 'falhou' and run5.get('status') == 'failed',
          resultado=s5.get('resultado'), run=run5, motivo=s5.get('motivo'))
    check('6 resultados da execução que falhou apagados', run5.get('metrics') == 0)
    check('6 análise em uso continua a anterior', all(c['run'] == s2.get('runId') for c in state5['companies']))

    stale = psql_json("""insert into private.intel_runs (trigger, algorithm_version, as_of, started_at, status)
        values ('test', 'teste-parada', current_date, now() - interval '10 minutes', 'running')
        returning json_build_object('id', id);""")
    rc, s6, err = runner()
    stale_row = run_row((stale or {}).get('id'))
    state6 = state()
    check('7 execução parada sem processo do motor vira falha', stale_row.get('status') == 'failed'
          and 'sem o processo' in (stale_row.get('error') or ''), run=stale_row)
    check('7 e a rotina publica a nova', s6.get('resultado') == 'publicada'
          and all(c['run'] == s6.get('runId') for c in state6['companies']), resultado=s6.get('resultado'))

    rc, s7, err = runner('--verificar')
    check('8 verificação com a análise de hoje publicada: ok', s7.get('resultado') == 'ok', resultado=s7.get('resultado'))
    set_enabled(False)
    mark('inteligência desligada na cópia')
    runs_now = state()['runs']
    rc, s8, err = runner()
    rc, s9, err = runner('--verificar')
    check('8 desligada: a rotina e a verificação não rodam nada', s8.get('resultado') == 'desligada'
          and s9.get('resultado') == 'desligada' and state()['runs'] == runs_now)
    check('9 a cópia não escreve alerta no log do monitor da produção', warn_lines() == warn_before)

    try:
        history = json.loads(STATUS.read_text(encoding='utf-8')).get('ultimas') or []
    except (OSError, ValueError):
        history = []
    report.update({'checks': checks, 'allOk': all(c['ok'] for c in checks), 'failed': [c['name'] for c in checks
                   if not c['ok']], 'timeline': timeline, 'history': history[:12], 'after': state(),
                   'engineSeconds': {k: (v or {}).get('motor') for k, v in (('cron', s1), ('again', s2), ('stale', s6))},
                   'finished': dt.datetime.now().isoformat(timespec='seconds')})
    print(json.dumps(report, indent=1, ensure_ascii=False, default=str))


main()
