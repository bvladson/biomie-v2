#!/usr/bin/env python3
"""BIOMIE v2 — análise diária da Inteligência do Estoque (rotina do SERVIDOR).

Instalada em /opt/biomie-v2/bin/intel_diaria.py e chamada pelo cron /etc/cron.d/biomie-v2-intel
(`python ops/remote.py ops/42_intel.py agenda instalar --sha256=<hash>`):

    intel_diaria.py                # 06:33: roda o motor (trigger schedule) se a inteligência estiver ligada
    intel_diaria.py --se-faltar    # 07:03: nova tentativa só se ainda não saiu a análise de hoje
    intel_diaria.py --verificar    # 07:35: só confere se a análise de hoje saiu (alerta se não saiu)
    intel_diaria.py --alvo=copia   # o mesmo na cópia da homologação (biomie_v2_hml), para os testes
    intel_diaria.py --alvo=copia --teste-falha   # teste: derruba o motor no meio da execução

Cada chamada: trava própria (uma por vez) → chave da inteligência (desligada = não roda nada) → execução
"parada" sem processo do motor vira falha (senão bloquearia por 2 h) → imagem do motor da release ativa
(refeita se a limpeza diária do Docker, 05:01, a apagou; na produção um contêiner "reserva", que nunca roda,
segura a imagem) → motor com tempo máximo → conferência do que foi gravado: as 5 empresas na mesma
execução, diagnósticos, recomendações, foto do dia, histórico das curvas e capital do motor = posições
(mesma conta do ops/43_intel_check.py) → situação em /opt/biomie-v2/ops/intel-diaria.json e um evento por
linha em /var/log/biomie-v2-intel.log.

Falha, análise que não saiu até a verificação ou conferência diferente viram alerta WARN no log do monitor
de saúde (/var/log/biomie-v2-health.log, lido pelo ops/36_stability.py). Falha nunca apaga a análise
anterior: o motor só troca tudo no fim, e a tela continua com a última publicada. Rodar duas vezes no
mesmo dia é seguro: a foto do dia e o histórico das curvas daquele dia são substituídos, não duplicados.
Nada aqui chama o Omie, compra, transfere ou muda preço. Nenhum segredo é impresso ou gravado em log.
"""
import datetime as dt
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import time

BASE = pathlib.Path('/opt/biomie-v2')
STACK_ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(STACK_ENV), '-f', str(BASE / 'compose.yml')]
HML = BASE / 'hml'
HML_PROJECT = 'biomie-hml'
HML_BUILDER = 'biomie-hml-limitado'  # o mesmo builder limitado (1 CPU, 3 GB) do ops/41_homolog.py
LOCK = pathlib.Path('/run/lock/biomie-v2-intel.lock')
HEALTH_LOG = pathlib.Path('/var/log/biomie-v2-health.log')
PIN = 'biomie-v2-intel-reserva'
ENGINE_SECONDS = 1500  # o próprio motor desiste em 1200 s (BIOMIE_INTEL_MAX_SECONDS)
BUILD_SECONDS = 1200
KEEP_HISTORY = 30
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TARGETS = {
    'producao': {'db': 'biomie_v2', 'status': BASE / 'ops' / 'intel-diaria.json',
                 'log': pathlib.Path('/var/log/biomie-v2-intel.log'), 'container': 'biomie-v2-intel-diaria',
                 'warn': True},
    'copia': {'db': 'biomie_v2_hml', 'status': HML / 'intel-diaria.json', 'log': HML / 'intel-diaria.log',
              'container': 'biomie-hml-intel-diaria', 'warn': False},
}
OK_RESULTS = ('publicada', 'desligada', 'ja_publicada', 'em_andamento', 'ok')


class Falha(Exception):
    """Falha esperada (banco, imagem, motor): vira o resultado 'falhou' com o motivo."""


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def iso(value):
    return value.isoformat(timespec='seconds')


def local_midnight_utc():
    """Meia-noite de hoje no fuso do servidor (America/Fortaleza, −03), em UTC."""
    now = dt.datetime.now().astimezone()
    return now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(dt.timezone.utc)


def read_env(path):
    try:
        return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
    except OSError:
        return {}


def secret_values():
    values = list(read_env(STACK_ENV).values()) + list(read_env(HML / 'hml.env').values())
    return sorted({v for v in values if len(v) > 12}, key=len, reverse=True)


def clean(text):
    text = text or ''
    for value in secret_values():
        text = text.replace(value, '[REDACTED]')
    return text


def sh(cmd, timeout=120, input=None):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
                              timeout=timeout, input=input)
    except subprocess.TimeoutExpired as error:
        raise Falha(f"tempo esgotado em {' '.join(cmd[:3])} ({timeout} s)") from error


def parse(argv):
    opts = {'alvo': 'producao', 'modo': 'normal', 'tempo': ENGINE_SECONDS, 'falha': False}
    for arg in argv:
        if arg == '--se-faltar':
            opts['modo'] = 'se-faltar'
        elif arg == '--verificar':
            opts['modo'] = 'verificar'
        elif arg.startswith('--alvo='):
            opts['alvo'] = arg.split('=', 1)[1]
        elif arg.startswith('--tempo-max='):
            opts['tempo'] = int(arg.split('=', 1)[1])
        elif arg == '--teste-falha':
            opts['falha'] = True
        else:
            raise SystemExit(f'opção desconhecida: {arg}\n{__doc__}')
    if opts['alvo'] not in TARGETS:
        raise SystemExit('--alvo=producao ou --alvo=copia')
    if opts['falha'] and opts['alvo'] != 'copia':
        raise SystemExit('--teste-falha só na cópia (--alvo=copia)')
    if not 30 <= opts['tempo'] <= 3600:
        raise SystemExit('--tempo-max entre 30 e 3600 segundos')
    return opts


class Rotina:
    def __init__(self, opts):
        self.o = opts
        self.t = TARGETS[opts['alvo']]
        self.started = utc_now()
        self.status = {'at': iso(self.started), 'alvo': opts['alvo'], 'modo': opts['modo'],
                       'banco': self.t['db'], 'resultado': None}

    # ------------------------------------------------------------------ registro
    def log(self, event, **fields):
        record = {'at': iso(utc_now()), 'alvo': self.o['alvo'], 'event': event}
        record.update({k: v for k, v in fields.items() if k not in record})
        line = clean(json.dumps(record, ensure_ascii=False, default=str))
        try:
            self.t['log'].parent.mkdir(parents=True, exist_ok=True)
            with self.t['log'].open('a', encoding='utf-8') as handle:
                handle.write(line + '\n')
        except OSError:
            pass
        print(line, flush=True)

    def finish(self, result, **fields):
        self.status.update(fields)
        self.status['resultado'] = result
        self.status['fim'] = iso(utc_now())
        self.status['segundos'] = round((utc_now() - self.started).total_seconds())
        problems = []
        if result not in OK_RESULTS:
            problems.append(self.status.get('motivo') or result)
        if self.status.get('consistente') is False:
            problems.extend(self.status.get('problemas') or ['conferência diferente'])
        previous = {}
        try:
            previous = json.loads(self.t['status'].read_text(encoding='utf-8'))
        except (OSError, ValueError):
            pass
        history = [h for h in previous.get('ultimas') or [] if isinstance(h, dict)]
        history.insert(0, {'at': self.status['at'], 'modo': self.o['modo'], 'resultado': result,
                           'runId': self.status.get('runId'), 'motivo': self.status.get('motivo'),
                           'consistente': self.status.get('consistente')})
        self.status['ultimas'] = history[:KEEP_HISTORY]
        if result == 'publicada':
            self.status['ultimaPublicada'] = {'at': self.status['fim'], 'runId': self.status.get('runId')}
        elif previous.get('ultimaPublicada'):
            self.status['ultimaPublicada'] = previous['ultimaPublicada']
        try:
            self.t['status'].parent.mkdir(parents=True, exist_ok=True)
            tmp = self.t['status'].with_suffix('.tmp')
            tmp.write_text(clean(json.dumps(self.status, indent=1, ensure_ascii=False, default=str)),
                           encoding='utf-8')
            tmp.chmod(0o644)
            tmp.replace(self.t['status'])
        except OSError as error:
            problems.append(f'situação não gravada: {error}')
        if problems and self.t['warn']:
            try:
                with HEALTH_LOG.open('a', encoding='utf-8') as handle:
                    for problem in problems:
                        handle.write(f"{utc_now().isoformat()} WARN inteligencia diaria {result}: "
                                     f"{clean(str(problem))[:200]}\n")
            except OSError:
                pass
        self.log('fim', situacao={k: v for k, v in self.status.items() if k != 'ultimas'})
        return 0 if not problems else 1

    # ------------------------------------------------------------------ banco
    def psql(self, sql, timeout=180):
        p = sh(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', self.t['db'], '-At',
                          '-v', 'ON_ERROR_STOP=1'], timeout, input=sql)
        if p.returncode:
            raise Falha('banco: ' + clean(p.stderr or p.stdout).strip()[-300:])
        return p.stdout.strip()

    def psql_json(self, sql, timeout=180):
        lines = [line for line in self.psql(sql, timeout).splitlines() if line.startswith(('{', '['))]
        return json.loads(lines[-1]) if lines else None

    def enabled(self):
        data = self.psql_json("select json_build_object('enabled', "
                              "(select s.enabled from private.intel_settings s where s.id));")
        return bool((data or {}).get('enabled'))

    def published_today(self):
        return self.psql_json(f"""select json_build_object('id', r.id, 'started', r.started_at,
            'finished', r.finished_at, 'asOf', r.as_of) from private.intel_runs r
            where r.trigger = 'schedule' and r.status = 'published'
              and r.started_at >= '{iso(local_midnight_utc())}'::timestamptz
            order by r.started_at desc limit 1;""")

    def running_runs(self, since=None):
        where = f"and r.started_at >= '{iso(since)}'::timestamptz" if since else ''
        rows = self.psql_json(f"""select coalesce(json_agg(json_build_object('id', r.id, 'started', r.started_at,
            'trigger', r.trigger)), '[]') from private.intel_runs r where r.status = 'running' {where};""") or []
        return [r for r in rows if UUID.match(str(r.get('id')))]

    def fail_runs(self, runs, message):
        text = message.replace("'", "''")[:280]
        for run in runs:
            self.psql(f"select stock_internal.intel_fail('{run['id']}'::uuid, '{text}');")

    # ------------------------------------------------------------------ motor
    def engine_containers(self, image):
        if self.o['alvo'] == 'producao':
            p = sh(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=biomie-v2',
                    '--filter', 'label=com.docker.compose.service=intelligence'])
        else:
            p = sh(['docker', 'ps', '-q', '--filter', f'ancestor={image}'])
        return p.stdout.split()

    def clear_stale(self, image):
        """Execução 'running' sem nenhum processo do motor vivo (o servidor caiu no meio, por exemplo): o banco
        só a abandonaria depois de 2 h, bloqueando a nova tentativa das 07:03. Vira falha agora."""
        runs = self.running_runs()
        if not runs:
            return
        if self.engine_containers(image):
            return  # há um motor rodando de verdade: o próprio motor vai responder "em andamento"
        self.fail_runs(runs, 'Execução interrompida sem o processo do motor (marcada pela rotina diária).')
        self.log('execucao_parada_marcada_como_falha', runs=runs)

    def image(self):
        if self.o['alvo'] == 'producao':
            release = read_env(STACK_ENV).get('RELEASE_ID', '')
            if not re.fullmatch(r'[0-9a-f]{12}', release):
                raise Falha('RELEASE_ID ausente ou inválido no stack.env')
            return release, f'biomie-v2-intel:{release}'
        p = sh(['docker', 'inspect', f'{HML_PROJECT}-hml-web-1', '--format', '{{.Config.Image}}'])
        if p.returncode:
            raise Falha('homologação fora do ar (sem o contêiner hml-web)')
        short = p.stdout.strip().rsplit('hml-', 1)[-1]
        if not re.fullmatch(r'[0-9a-f]{12}', short):
            raise Falha(f'imagem da homologação inesperada: {p.stdout.strip()[:80]}')
        return short, f'biomie-v2-intel:hml-{short}'

    def ensure_image(self, release, image):
        if sh(['docker', 'image', 'inspect', image]).returncode == 0:
            self.status['imagem'] = {'nome': image, 'construida': False}
        else:
            started = time.time()
            if self.o['alvo'] == 'producao':
                p = sh(COMPOSE + ['--profile', 'jobs', 'build', 'intelligence'], BUILD_SECONDS)
            else:
                folder = BASE / 'releases' / release
                commit = json.loads((folder / 'RELEASE.json').read_text()).get('commit', 'unknown')
                if sh(['docker', 'buildx', 'inspect', HML_BUILDER]).returncode:
                    sh(['docker', 'buildx', 'create', '--name', HML_BUILDER, '--driver', 'docker-container',
                        '--driver-opt', 'cpu-period=100000', '--driver-opt', 'cpu-quota=100000',
                        '--driver-opt', 'memory=3g'])
                p = sh(['docker', 'buildx', 'build', '--builder', HML_BUILDER, '--load', '-f',
                        str(folder / 'intelligence/Dockerfile'), '--build-arg', f'GIT_COMMIT={commit}',
                        '-t', image, str(folder)], BUILD_SECONDS)
            if p.returncode or sh(['docker', 'image', 'inspect', image]).returncode:
                raise Falha('imagem do motor não foi construída: ' + clean(p.stderr or p.stdout).strip()[-300:])
            self.status['imagem'] = {'nome': image, 'construida': True,
                                     'segundosDoBuild': round(time.time() - started)}
            self.log('imagem_construida', image=image, seconds=self.status['imagem']['segundosDoBuild'])
        if self.o['alvo'] == 'producao':
            self.pin(image)

    def pin(self, image):
        """Contêiner que nunca roda (sem rede, sem variáveis, entrada /bin/true): a limpeza diária do Docker
        (image prune -a, 05:01) só apaga imagem sem contêiner; assim a das 06:33 não precisa ser refeita."""
        current = sh(['docker', 'inspect', PIN, '--format', '{{.Config.Image}}'])
        if current.returncode == 0 and current.stdout.strip() == image:
            return
        if current.returncode == 0:
            sh(['docker', 'rm', PIN])
        p = sh(['docker', 'create', '--name', PIN, '--network', 'none', '--entrypoint', '/bin/true',
                '--label', 'biomie-v2.reserva=intel', image])
        self.log('reserva_da_imagem', image=image, ok=p.returncode == 0,
                 error=None if p.returncode == 0 else clean(p.stderr).strip()[-200:])

    def engine_command(self, image, env_file):
        name = self.t['container']
        if self.o['alvo'] == 'producao':
            return COMPOSE + ['--profile', 'jobs', 'run', '--rm', '--no-deps', '--name', name, 'intelligence',
                              'run', '--trigger', 'schedule']
        return ['docker', 'run', '--rm', '--name', name, '--network', f'{HML_PROJECT}_hml', '--cpus', '0.5',
                '--memory', '512m', '--env-file', str(env_file), image, 'run', '--trigger', 'schedule']

    def kill(self):
        sh(['docker', 'kill', self.t['container']], 60)

    def engine(self, image):
        name = self.t['container']
        state = sh(['docker', 'inspect', name, '--format', '{{.State.Running}}'])
        if state.returncode == 0:
            if state.stdout.strip() == 'true':
                return {'skipped': 'Já existe uma execução em andamento.'}
            sh(['docker', 'rm', name])  # sobra de uma execução que caiu
        env_file = HML / 'intel-diaria.env'
        if self.o['alvo'] == 'copia':
            key = read_env(HML / 'hml.env').get('HML_SERVICE_KEY')
            if not key:
                raise Falha('chave de serviço da homologação ausente (hml.env)')
            fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as handle:
                handle.write(f'SUPABASE_URL=http://hml-gateway:8000\nSUPABASE_SERVICE_ROLE_KEY={key}\n'
                             'BIOMIE_INTEL_MAX_SECONDS=1200\n')
        started = time.time()
        killed = None
        try:
            proc = subprocess.Popen(self.engine_command(image, env_file), stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
            deadline = started + self.o['tempo']
            if self.o['falha']:
                # Teste de falha: espera a execução aparecer no banco e derruba o motor no meio dela.
                while proc.poll() is None and time.time() < deadline:
                    if self.running_runs(self.started):
                        time.sleep(2)
                        self.kill()
                        killed = 'teste de falha: motor derrubado no meio da execução'
                        break
                    time.sleep(1)
            try:
                out, err = proc.communicate(timeout=max(1.0, deadline - time.time()))
            except subprocess.TimeoutExpired:
                self.kill()
                killed = f"tempo máximo da rotina esgotado ({self.o['tempo']} s)"
                out, err = proc.communicate(timeout=120)
        finally:
            if self.o['alvo'] == 'copia':
                env_file.unlink(missing_ok=True)
        events = []
        for line in (out or '').splitlines():
            if line.startswith('{'):
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
        for event in events:
            self.log('motor', dados=event)
        return {'exit': proc.returncode, 'killed': killed, 'events': events, 'seconds': round(time.time() - started),
                'stderr': clean(err).strip()[-600:]}

    # ------------------------------------------------------------------ conferência
    def verify(self, run_id):
        data = self.psql_json(f"""
with r as (select * from private.intel_runs where id = '{run_id}'::uuid),
co as (select c.id, c.slug from public.companies c join private.stock_current sc on sc.company_id = c.id
       where not c.is_demo),
m as (select x.company_id, count(*) as products,
        count(*) filter (where jsonb_array_length(case when jsonb_typeof(x.metrics->'diagnoses') = 'array'
          then x.metrics->'diagnoses' else '[]'::jsonb end) > 0) as with_diagnosis,
        count(*) filter (where jsonb_array_length(case when jsonb_typeof(x.metrics->'recommendations') = 'array'
          then x.metrics->'recommendations' else '[]'::jsonb end) > 0) as with_recommendation,
        count(*) filter (where jsonb_array_length(case when jsonb_typeof(x.metrics->'alerts') = 'array'
          then x.metrics->'alerts' else '[]'::jsonb end) > 0) as with_alert,
        round(coalesce(sum((x.metrics->>'capital')::numeric), 0), 2) as capital
      from private.intel_product_metrics x where x.run_id = (select id from r) group by x.company_id),
s as (select s.company_id, s.day, s.captured_at from private.stock_snapshots s
      where s.captured_at >= (select started_at from r)),
h as (select h.company_id, h.day, count(*) as n from private.stock_curve_history h
      join s on s.company_id = h.company_id and s.day = h.day group by 1, 2),
pos as (select t.company_id, coalesce(sum(round(t.value, 2)), 0) as capital_by_product
        from (select sc.company_id, p.omie_product_id,
                sum(p.physical_qty * p.unit_cost) filter (where p.physical_qty > 0 and p.unit_cost > 0) as value
              from private.stock_current sc join private.stock_positions p on p.reading_id = sc.reading_id
              group by 1, 2) t group by 1)
select json_build_object(
  'run', (select json_build_object('id', r.id, 'status', r.status, 'trigger', r.trigger, 'asOf', r.as_of,
            'started', r.started_at, 'finished', r.finished_at, 'version', r.algorithm_version,
            'seconds', round(extract(epoch from r.finished_at - r.started_at))) from r),
  'companies', (select coalesce(json_agg(json_build_object('company', co.slug,
      'current', exists (select 1 from private.intel_current ic where ic.company_id = co.id
                         and ic.run_id = (select id from r)),
      'products', coalesce(m.products, 0), 'withDiagnosis', coalesce(m.with_diagnosis, 0),
      'withRecommendation', coalesce(m.with_recommendation, 0), 'withAlert', coalesce(m.with_alert, 0),
      'snapshotDay', s.day, 'snapshotAt', s.captured_at, 'curveHistoryRows', coalesce(h.n, 0),
      'capitalEngine', m.capital, 'capitalPositions', pos.capital_by_product) order by co.slug), '[]')
    from co left join m on m.company_id = co.id left join s on s.company_id = co.id
    left join h on h.company_id = co.id and h.day = s.day left join pos on pos.company_id = co.id),
  'opportunities', (select count(*) from private.intel_opportunities o where o.run_id = (select id from r)),
  'alertsOpen', (select count(*) from private.intel_alerts a where a.status = 'open'),
  'snapshotDays', (select count(distinct day) from private.stock_snapshots),
  'curveHistoryDays', (select count(distinct day) from private.stock_curve_history));""") or {}
        problems = []
        run = data.get('run') or {}
        if run.get('status') != 'published':
            problems.append(f"execução {run_id} com status {run.get('status')}")
        companies = data.get('companies') or []
        if not companies:
            problems.append('nenhuma empresa com leitura de estoque publicada')
        for c in companies:
            name = c.get('company')
            if not c.get('current'):
                problems.append(f'{name}: a análise em uso não é desta execução')
            if not c.get('products'):
                problems.append(f'{name}: nenhum produto analisado')
            if not c.get('snapshotDay'):
                problems.append(f'{name}: foto do dia não gravada')
            engine, positions = c.get('capitalEngine'), c.get('capitalPositions')
            if round(float(engine or 0), 2) != round(float(positions or 0), 2):
                problems.append(f'{name}: capital do motor diferente das posições')
        if companies and not sum(c.get('withDiagnosis') or 0 for c in companies):
            problems.append('nenhum diagnóstico gravado')
        if companies and not sum(c.get('withRecommendation') or 0 for c in companies):
            problems.append('nenhuma recomendação gravada')
        data['problemas'] = problems
        return data

    # ------------------------------------------------------------------ fluxo
    def verificar(self, enabled):
        if not enabled:
            return self.finish('desligada', motivo='inteligência desligada (ops/42_intel.py enable liga)')
        today = self.published_today()
        if today:
            return self.finish('ok', runId=today.get('id'), publicadaEm=today.get('finished'))
        return self.finish('atrasada', motivo='a análise diária de hoje não foi publicada até a verificação')

    def steps(self):
        self.log('inicio', modo=self.o['modo'], banco=self.t['db'], pid=os.getpid())
        enabled = self.enabled()
        if self.o['modo'] == 'verificar':
            return self.verificar(enabled)
        if not enabled:
            return self.finish('desligada', motivo='inteligência desligada (ops/42_intel.py enable liga)')
        if self.o['modo'] == 'se-faltar':
            today = self.published_today()
            if today:
                return self.finish('ja_publicada', runId=today.get('id'), publicadaEm=today.get('finished'))
        release, image = self.image()
        self.status['release'] = release
        self.clear_stale(image)
        self.ensure_image(release, image)
        result = self.engine(image)
        self.status['motor'] = {k: result[k] for k in ('exit', 'seconds', 'killed')}
        published = next((e for e in result['events'] if e.get('event') == 'intel_published'), None)
        failed = next((e for e in result['events'] if e.get('event') == 'intel_failed'), None)
        skipped = result.get('skipped') or next((e.get('reason') for e in result['events']
                                                 if e.get('event') == 'intel_skipped'), None)
        if result['killed']:
            runs = self.running_runs(self.started)
            self.fail_runs(runs, 'Interrompida pela rotina diária: ' + result['killed'][:120].replace("'", ''))
            return self.finish('falhou', motivo=result['killed'], runId=(runs[0]['id'] if runs else None))
        if published and UUID.match(str(published.get('runId'))):
            check = self.verify(published['runId'])
            return self.finish('publicada', runId=published['runId'], conferencia=check,
                               consistente=not check['problemas'], problemas=check['problemas'])
        if skipped:
            if 'desligado' in skipped:
                return self.finish('desligada', motivo=skipped)
            if 'andamento' in skipped:
                return self.finish('em_andamento', motivo=skipped)
            return self.finish('falhou', motivo=f'motor não começou: {skipped}')
        reason = (failed or {}).get('error') or result.get('stderr') or f"motor saiu com {result['exit']}"
        return self.finish('falhou', motivo=clean(str(reason))[-300:], runId=(failed or {}).get('runId'))

    def run(self):
        try:
            LOCK.parent.mkdir(parents=True, exist_ok=True)
            with open(LOCK, 'a+') as handle:  # a trava sai quando o arquivo fecha (ou o processo acaba)
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    return self.finish('em_andamento', motivo='outra chamada da rotina está rodando (trava)')
                try:
                    return self.steps()
                finally:
                    fcntl.flock(handle, fcntl.LOCK_UN)
        except Falha as error:
            return self.finish('falhou', motivo=clean(str(error))[:300])
        except Exception as error:  # noqa: BLE001 - qualquer erro inesperado vira falha registrada
            return self.finish('falhou', motivo=clean(f'{type(error).__name__}: {error}')[:300])


def main(argv=None):
    # No cron não há idioma definido: saída e arquivos sempre em UTF-8 (os textos do motor têm acentos).
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    return Rotina(parse(sys.argv[1:] if argv is None else argv)).run()


if __name__ == '__main__':
    sys.exit(main())
