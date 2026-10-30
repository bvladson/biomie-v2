"""Publish only the reviewed floating-scroll UI, preserving every other service.

Stream with ops/remote.py: 51_publish_ui.py prepare|activate|rollback|status SHA12 BASE_SHA40
The host compose file stays in place. No migrations, SQL, jobs, worker or gateway operations.
The dedicated, externally provisioned builder must be limited to one CPU and 3 GiB.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared/stack.env'
COMPOSE_FILE = BASE / 'compose.yml'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(COMPOSE_FILE)]
BUILDER = 'biomie-ui-scroll'
SERVICES = ('web', 'worker', 'db', 'auth', 'rest', 'gateway')
POINTERS = ('RELEASE_ID', 'SOURCE_DIR', 'BIOMIE_GIT_COMMIT')
ALLOWED = {
    'docs/FLOATING_TABLE_SCROLL.md',
    'src/components/layout/GlobalFloatingTableScroll.tsx',
    'src/lib/floating-table-scroll.ts',
    'src/routes/_authenticated/_shell.tsx',
    'src/styles.css',
    'src/styles/floating-table-scroll.css',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_env(data=None):
    values = {}
    for line in (ENV.read_bytes() if data is None else data).decode().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def redact(message):
    for value in sorted(read_env().values(), key=len, reverse=True):
        if len(value) >= 8:
            message = message.replace(value, '[REDACTED]')
    return message


def run(command, env=None, timeout=180, optional=False, log=None):
    try:
        if log:
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w') as handle:
                result = subprocess.run(command, stdout=handle, stderr=subprocess.STDOUT,
                                        text=True, timeout=timeout, env=env)
            output = pathlib.Path(log).read_text(errors='replace')[-3000:]
        else:
            result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=env)
            output = (result.stderr or result.stdout)[-3000:]
    except subprocess.TimeoutExpired:
        raise RuntimeError('Command exceeded its time limit: ' + ' '.join(command[:3])) from None
    if result.returncode and not optional:
        raise RuntimeError('Command failed: ' + ' '.join(command[:3]) + ': ' + redact(output))
    return '' if result.returncode or log else result.stdout.strip()


def private_write(path, content):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.tmp-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def container(name, optional=False):
    template = ('{{json .Id}}|{{json .Image}}|'
                '{{json (index .Config.Labels "org.opencontainers.image.revision")}}|'
                '{{json .State.Status}}|{{if index .State "Health"}}'
                '{{json (index (index .State "Health") "Status")}}{{else}}null{{end}}')
    output = run(['docker', 'inspect', '--format', template, name], optional=optional)
    if not output:
        return None
    return dict(zip(('id', 'image_id', 'revision', 'status', 'health'),
                    (json.loads(value) for value in output.split('|'))))


def containers():
    # The web can be temporarily absent after a failed recreation; rollback must
    # still be able to verify protected services and restore the previous web.
    return {service: container('biomie-v2-' + service + '-1', optional=service == 'web') for service in SERVICES}


def image(short):
    output = run(['docker', 'image', 'inspect', '--format',
                  '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',
                  'biomie-v2-web:' + short])
    image_id, revision = output.split('|')
    return {'id': image_id, 'revision': revision}


def checked_release(short):
    if not re.fullmatch('[a-f0-9]{12}', short):
        raise RuntimeError('Candidate must be a 12-character lowercase commit prefix')
    release = BASE / 'releases' / short
    if release.resolve() != release or not release.is_dir():
        raise RuntimeError('Candidate release path is missing or is a symlink')
    meta = json.loads((release / 'RELEASE.json').read_text())
    commit = meta.get('commit', '')
    if not re.fullmatch('[a-f0-9]{40}', commit) or not commit.startswith(short) or meta.get('short') != short:
        raise RuntimeError('Candidate RELEASE.json does not match its directory')
    return release, commit


def source_files(directory):
    files = {}
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('Source contains a symlink: ' + str(path.relative_to(directory)))
        relative = path.relative_to(directory).as_posix()
        if path.is_file() and relative != 'RELEASE.json':
            files[relative] = digest(path.read_bytes())
    return files


def check_source_delta(release, current):
    previous = pathlib.Path(current['SOURCE_DIR'])
    if previous.resolve() != BASE / 'releases' / current['RELEASE_ID']:
        raise RuntimeError('Active source pointer does not match its release directory')
    if json.loads((previous / 'RELEASE.json').read_text()).get('commit') != current['BIOMIE_GIT_COMMIT']:
        raise RuntimeError('Active release metadata does not match the expected base')
    old, new = source_files(previous), source_files(release)
    changed = sorted(path for path in old.keys() | new.keys() if old.get(path) != new.get(path))
    if set(changed) != ALLOWED:
        raise RuntimeError('Candidate differs outside the six reviewed UI files: ' + json.dumps(changed))
    return changed


def target_env(original, short, commit):
    values = {'RELEASE_ID': short, 'SOURCE_DIR': str(BASE / 'releases' / short), 'BIOMIE_GIT_COMMIT': commit}
    result = original
    for key, value in values.items():
        result, count = re.subn(rb'(?m)^' + key.encode() + rb'=[^\r\n]*(\r?)$',
                                lambda match: key.encode() + b'=' + value.encode() + match.group(1), result)
        if count != 1:
            raise RuntimeError('Release pointer must occur exactly once: ' + key)
    return result


def protected_unchanged(state):
    if digest(COMPOSE_FILE.read_bytes()) != state['compose_sha256']:
        raise RuntimeError('Host compose changed since snapshot')
    actual = containers()
    for service in SERVICES[1:]:
        if actual[service]['id'] != state['containers'][service]['id'] or actual[service]['image_id'] != state['containers'][service]['image_id']:
            raise RuntimeError('Protected service changed since snapshot: ' + service)
    return actual


def baseline_unchanged(state):
    if digest(ENV.read_bytes()) != state['env_sha256'] or stat.S_IMODE(ENV.stat().st_mode) != state['env_mode']:
        raise RuntimeError('stack.env changed since snapshot')
    actual = protected_unchanged(state)
    expected = state.get('restored_web', state['containers']['web'])
    if not actual['web'] or actual['web']['id'] != expected['id'] or actual['web']['image_id'] != expected['image_id'] or actual['web']['revision'] != state['base_commit']:
        raise RuntimeError('Production web changed since snapshot')
    return actual


def healthy(name, revision, seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        actual = container(name, optional=True)
        if actual and actual['health'] == 'healthy' and actual['revision'] == revision:
            return actual
        time.sleep(3)
    raise RuntimeError(name + ' did not become healthy with the expected revision')


def http_ok(url):
    with urllib.request.urlopen(url, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError('HTTP health check did not return 200')
    return 200


def stop_owned_preview(state):
    actual = container(state['preview_name'], optional=True)
    if actual:
        if actual['revision'] != state['commit'] or actual['image_id'] != state['image']['id']:
            raise RuntimeError('Preview name is owned by another image; refusing removal')
        run(['docker', 'rm', '-f', state['preview_name']])


def save(state, path):
    state['updated_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    private_write(path, json.dumps(state, indent=2).encode())


def prepare(args, state_path, state):
    release, commit = checked_release(args.short)
    current = read_env()
    if current.get('BIOMIE_GIT_COMMIT') != args.base or current.get('RELEASE_ID') != args.base[:12]:
        raise RuntimeError('Production does not match the explicitly expected base commit')
    changed = check_source_delta(release, current)
    if not state:
        original = ENV.read_bytes()
        mode = stat.S_IMODE(ENV.stat().st_mode)
        actual = containers()
        if mode != 0o600 or not actual['web'] or actual['web']['revision'] != args.base or actual['web']['health'] != 'healthy':
            raise RuntimeError('Production env permissions/revision/health do not match the base')
        backup = state_path.parent / 'stack.env.before'
        private_write(backup, original)
        state = {'status': 'snapshotted', 'short': args.short, 'commit': commit, 'base_commit': args.base,
                 'env_backup': str(backup), 'env_sha256': digest(original), 'env_mode': mode,
                 'compose_sha256': digest(COMPOSE_FILE.read_bytes()), 'previous_pointers': {key: current[key] for key in POINTERS},
                 'target_env_sha256': digest(target_env(original, args.short, commit)),
                 'containers': actual, 'changed_files': changed,
                 'preview_name': 'biomie-v2-ui-preview-' + args.short}
        save(state, state_path)
    baseline_unchanged(state)
    builder = json.loads(run(['docker', 'inspect', '--format', '{{json .HostConfig}}',
                              'buildx_buildkit_' + BUILDER + '0']))
    if not (0 < builder.get('Memory', 0) <= 3 * 1024 ** 3 and
            0 < builder.get('CpuQuota', 0) <= builder.get('CpuPeriod', 0)):
        raise RuntimeError('Dedicated builder is not bounded to one CPU and at most 3 GiB')
    state['status'] = 'building'
    save(state, state_path)
    build_env = {**os.environ, 'VITE_SUPABASE_URL': current['PUBLIC_SUPABASE_URL'],
                 'VITE_SUPABASE_PUBLISHABLE_KEY': current['ANON_KEY'], 'GIT_COMMIT': commit}
    log = state_path.parent / 'build.log'
    run(['docker', 'buildx', 'build', '--builder', BUILDER, '--load', '--progress=plain',
         '--tag', 'biomie-v2-web:' + args.short, '--file', str(release / 'deploy/vps/Dockerfile'),
         '--build-arg', 'VITE_SUPABASE_URL', '--build-arg', 'VITE_SUPABASE_PUBLISHABLE_KEY',
         '--build-arg', 'GIT_COMMIT', str(release)], env=build_env, timeout=2400, log=log)
    state['image'] = image(args.short)
    if state['image']['revision'] != commit:
        raise RuntimeError('Built image revision differs from the candidate commit')
    baseline_unchanged(state)
    preview = container(state['preview_name'], optional=True)
    if preview and (preview['revision'] != commit or preview['image_id'] != state['image']['id']):
        raise RuntimeError('Preview name belongs to a different image')
    if not preview:
        preview_env = {**os.environ, 'RELEASE_ID': args.short, 'SOURCE_DIR': str(release), 'BIOMIE_GIT_COMMIT': commit}
        run(COMPOSE + ['run', '-d', '--rm', '--no-deps', '--name', state['preview_name'],
                       '-p', '127.0.0.1:3132:3000', 'web'], env=preview_env)
    state['preview'] = healthy(state['preview_name'], commit)
    state['preview_auth_http'] = http_ok('http://127.0.0.1:3132/auth')
    baseline_unchanged(state)
    state['status'] = 'prepared'
    save(state, state_path)
    return state


def rollback(state, state_path):
    actual = protected_unchanged(state)
    current_hash = digest(ENV.read_bytes())
    if current_hash not in (state['env_sha256'], state['target_env_sha256']):
        raise RuntimeError('Refusing rollback over unrelated environment edits')
    if actual['web']:
        if actual['web']['revision'] not in (state['base_commit'], state['commit']):
            raise RuntimeError('Refusing rollback over an unrelated running release')
        expected_image = state['containers']['web']['image_id'] if actual['web']['revision'] == state['base_commit'] else state['image']['id']
        if actual['web']['image_id'] != expected_image:
            raise RuntimeError('Refusing rollback over an unrelated web image')
    original = pathlib.Path(state['env_backup']).read_bytes()
    if digest(original) != state['env_sha256']:
        raise RuntimeError('Private environment backup checksum mismatch')
    stop_owned_preview(state)
    if current_hash == state['env_sha256'] and actual['web'] and actual['web']['health'] == 'healthy':
        state['restored_web'] = actual['web']
        state['status'] = 'rolled_back'
        save(state, state_path)
        return state
    private_write(ENV, original)
    run(COMPOSE + ['up', '-d', '--no-deps', '--no-build', 'web'])
    state['restored_web'] = healthy('biomie-v2-web-1', state['base_commit'])
    protected_unchanged(state)
    if ENV.read_bytes() != original:
        raise RuntimeError('Rollback did not preserve the exact original environment bytes')
    state['status'] = 'rolled_back'
    save(state, state_path)
    return state


def activate(state, state_path):
    if digest(ENV.read_bytes()) == state['target_env_sha256']:
        try:
            protected_unchanged(state)
            state['activated_web'] = healthy('biomie-v2-web-1', state['commit'])
            if state['activated_web']['image_id'] != state['image']['id']:
                raise RuntimeError('Running candidate image differs from the prepared image')
            state['public_auth_http'] = http_ok(read_env()['APP_BASE_URL'].rstrip('/') + '/auth')
            state['status'] = 'activated'
            save(state, state_path)
            return state
        except Exception as error:
            state['activation_error'] = redact(str(error))
            save(state, state_path)
            rollback(state, state_path)
            raise RuntimeError('Candidate verification failed and was rolled back: ' + redact(str(error))) from None
    if state['status'] != 'prepared':
        raise RuntimeError('Candidate must complete prepare and private preview before activation')
    baseline_unchanged(state)
    if image(state['short']) != state['image']:
        raise RuntimeError('Candidate image changed after private preview')
    healthy(state['preview_name'], state['commit'])
    original = pathlib.Path(state['env_backup']).read_bytes()
    if digest(original) != state['env_sha256']:
        raise RuntimeError('Private environment backup checksum mismatch')
    stop_owned_preview(state)
    state['status'] = 'activating'
    save(state, state_path)
    try:
        private_write(ENV, target_env(original, state['short'], state['commit']))
        run(COMPOSE + ['up', '-d', '--no-deps', '--no-build', 'web'])
        state['activated_web'] = healthy('biomie-v2-web-1', state['commit'])
        if state['activated_web']['image_id'] != state['image']['id']:
            raise RuntimeError('Activated image differs from the prepared image')
        state['public_auth_http'] = http_ok(read_env()['APP_BASE_URL'].rstrip('/') + '/auth')
        protected_unchanged(state)
        if digest(ENV.read_bytes()) != state['target_env_sha256']:
            raise RuntimeError('Environment changed during activation')
        state['status'] = 'activated'
        save(state, state_path)
    except Exception as error:
        state['activation_error'] = redact(str(error))
        save(state, state_path)
        rollback(state, state_path)
        raise RuntimeError('Activation failed and was rolled back: ' + redact(str(error))) from None
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'activate', 'rollback', 'status'))
    parser.add_argument('short')
    parser.add_argument('base')
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{40}', args.base):
        raise RuntimeError('Expected base must be a full lowercase commit SHA')
    release, commit = checked_release(args.short)
    state_path = BASE / 'ops' / ('ui-publish-' + args.short) / 'state.json'
    if args.mode == 'status':
        current = read_env()
        print(json.dumps({'active': {key: current.get(key) for key in POINTERS},
                          'env_sha256': digest(ENV.read_bytes()), 'containers': containers(),
                          'candidate': {'short': args.short, 'commit': commit},
                          'state': json.loads(state_path.read_text()) if state_path.exists() else None}, indent=2))
        return
    if os.geteuid() != 0:
        raise RuntimeError('UI publication requires root on the VPS')
    (BASE / 'ops').mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(BASE / 'ops/ui-publish.lock', os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(state_path.read_text()) if state_path.exists() else None
        if state and (state['commit'] != commit or state['base_commit'] != args.base):
            raise RuntimeError('Existing snapshot belongs to a different candidate/base pair')
        if args.mode == 'prepare':
            state = prepare(args, state_path, state)
        elif not state:
            raise RuntimeError('No private snapshot exists for this candidate')
        elif args.mode == 'activate':
            state = activate(state, state_path)
        else:
            state = rollback(state, state_path)
        print(json.dumps(state, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        print(json.dumps({'ok': False, 'error': redact(str(failure))}), file=sys.stderr)
        raise SystemExit(1)
