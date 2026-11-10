"""Assistente MAG AI (Fase 4) — operação na VPS, um comando por passo.

    python ops/remote.py ops/59_assistente.py status
        Só leitura: variáveis no stack.env (presença, nunca o valor), rede, gateway visto de dentro
        do web, chave ai_assistant no banco e contagens dos últimos 7 dias (metadados).

    python ops/remote.py ops/59_assistente.py env-on
        Grava MAG_AI_URL e MAG_AI_KEY no stack.env (chave lida de /srv/mag-ai/CREDENCIAIS.txt,
        nunca mostrada) e recria SÓ o web. Não liga a chave do banco.

    python ops/remote.py ops/59_assistente.py env-off
        Tira as duas variáveis do stack.env e recria SÓ o web. O balão some para todos.

    python ops/remote.py ops/59_assistente.py flag on  [--papeis=SUPER_ADMIN]
    python ops/remote.py ops/59_assistente.py flag off
        Liga/desliga a chave ai_assistant (metric_config) e registra no audit_log (actor nulo = ops).
        Sem --papeis, "on" mantém os papéis atuais (ou SUPER_ADMIN na primeira vez).

Retorno completo do assistente = flag off (instantâneo) ou env-off (o balão nem renderiza).
A release anterior ignora a 0052; o retorno de release continua o de sempre (21 na anterior).
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
CRED = pathlib.Path('/srv/mag-ai/CREDENCIAIS.txt')
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml')]
ROLES_OK = {'SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR', 'VENDEDOR', 'FINANCEIRO', 'ANALISTA', 'VIEWER'}
ACTION = sys.argv[1] if len(sys.argv) > 1 else 'status'
# --db=biomie_v2_hml aponta flag/status para a CÓPIA (mesmo cluster); env-on/env-off não aceitam.
DB = next((a.split('=', 1)[1] for a in sys.argv[2:] if a.startswith('--db=')), 'biomie_v2')
if DB not in ('biomie_v2', 'biomie_v2_hml'):
    raise SystemExit('--db só aceita biomie_v2 ou biomie_v2_hml')
if DB != 'biomie_v2' and ACTION in ('env-on', 'env-off'):
    raise SystemExit('env-on/env-off são só da produção')
out = {'action': ACTION, 'db': DB}


def run(cmd, input=None, timeout=300):
    p = subprocess.run(cmd, input=input, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise SystemExit(f"FALHOU {' '.join(cmd[:4])}: {(p.stderr or p.stdout)[-800:]}")
    return (p.stdout or '').strip()


def psql(sql):
    return run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB,
                          '-v', 'ON_ERROR_STOP=1', '-At'], input=sql)


def env_lines():
    return ENV.read_text().splitlines()


def env_write(lines):
    ENV.write_text('\n'.join(lines) + '\n')


def recreate_web():
    run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'web'], timeout=600)
    state = run(['docker', 'inspect', '--format',
                 '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
                 'biomie-v2-web-1'])
    out['web'] = state
    # Espera ficar saudável (o healthcheck leva ~30 s).
    import time
    deadline = time.time() + 240
    while state != 'healthy' and time.time() < deadline:
        time.sleep(4)
        state = run(['docker', 'inspect', '--format',
                     '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
                     'biomie-v2-web-1'])
    out['web'] = state
    if state != 'healthy':
        raise SystemExit('web não ficou saudável depois da recriação')


if ACTION == 'status':
    keys = {l.split('=', 1)[0] for l in env_lines() if '=' in l}
    out['stack_env'] = {'MAG_AI_URL': 'MAG_AI_URL' in keys, 'MAG_AI_KEY': 'MAG_AI_KEY' in keys}
    out['rede'] = subprocess.run(['docker', 'network', 'inspect', 'mag-ai_biomie'],
                                 capture_output=True).returncode == 0
    web_net = subprocess.run(['docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}',
                              'biomie-v2-web-1'], capture_output=True, text=True)
    out['web_na_rede'] = 'mag-ai_biomie' in (web_net.stdout or '')
    probe = subprocess.run(['docker', 'exec', 'biomie-v2-web-1', 'node', '-e',
                            "fetch('http://mag-ai:8080/v1/health',{signal:AbortSignal.timeout(2500)})"
                            ".then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"
                            ".catch(e=>{console.log(JSON.stringify({erro:String(e&&e.cause&&e.cause.code||e)}))})"],
                           capture_output=True, text=True, timeout=30)
    try:
        out['gateway'] = json.loads((probe.stdout or '{}').strip() or '{}')
    except ValueError:
        out['gateway'] = {'erro': (probe.stderr or probe.stdout)[-200:]}
    out['chave_banco'] = json.loads(psql('select public.ai_assistant_config();') or '{}')
    out['pedidos_7d'] = json.loads(psql("""
        with q as (select * from private.ai_requests where created_at > now() - interval '7 days')
        select json_build_object('total', (select count(*) from q),
          'ok', (select count(*) from q where status='ok'),
          'descartadas', (select count(*) from q where status='descartada'),
          'falhas', (select count(*) from q where status in ('erro','indisponivel','ocupado','limite')),
          'uteis', (select count(*) from q where useful is true));
    """) or '{}')

elif ACTION == 'env-on':
    if not CRED.exists():
        raise SystemExit('CREDENCIAIS.txt do MAG AI não existe: instale o MAG AI antes (Fase 3).')
    key = next((l.split('=', 1)[1].strip() for l in CRED.read_text().splitlines()
                if l.startswith('biomie=')), '')
    if not re.fullmatch(r'magai_biomie_[A-Za-z0-9_-]{43}', key):
        raise SystemExit('chave biomie ausente ou com formato inesperado em CREDENCIAIS.txt')
    lines = [l for l in env_lines() if not l.startswith(('MAG_AI_URL=', 'MAG_AI_KEY='))]
    lines += ['MAG_AI_URL=http://mag-ai:8080', f'MAG_AI_KEY={key}']
    env_write(lines)
    out['stack_env'] = {'MAG_AI_URL': True, 'MAG_AI_KEY': True}
    recreate_web()

elif ACTION == 'env-off':
    env_write([l for l in env_lines() if not l.startswith(('MAG_AI_URL=', 'MAG_AI_KEY='))])
    out['stack_env'] = {'MAG_AI_URL': False, 'MAG_AI_KEY': False}
    recreate_web()

elif ACTION == 'flag':
    estado = sys.argv[2] if len(sys.argv) > 2 else ''
    if estado not in ('on', 'off'):
        raise SystemExit('uso: flag on|off [--papeis=SUPER_ADMIN,ADMIN]')
    papeis = None
    for a in sys.argv[3:]:
        if a.startswith('--papeis='):
            papeis = [p for p in a.split('=', 1)[1].split(',') if p]
    if papeis is not None and (not papeis or any(p not in ROLES_OK for p in papeis)):
        raise SystemExit(f'papéis inválidos: {papeis}')
    atual = json.loads(psql('select public.ai_assistant_config();') or '{}')
    roles = papeis if papeis is not None else (atual.get('roles') or ['SUPER_ADMIN'])
    cfg = json.dumps({'enabled': estado == 'on', 'roles': roles})
    psql(f"""
        insert into public.metric_config (metric_key, config) values ('ai_assistant', '{cfg}'::jsonb)
        on conflict (metric_key) do update
          set config = excluded.config, version = metric_config.version + 1, updated_at = now();
        insert into public.audit_log (actor_id, action, entity, entity_id, payload)
          values (null, 'ai_assistant_set', 'metric_config', 'ai_assistant',
                  jsonb_build_object('via', 'ops/59', 'config', '{cfg}'::jsonb));
    """)
    out['chave_banco'] = json.loads(psql('select public.ai_assistant_config();') or '{}')

else:
    raise SystemExit('ação desconhecida: ' + ACTION)

print(json.dumps(out, indent=1, ensure_ascii=False))
