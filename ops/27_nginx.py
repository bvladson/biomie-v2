"""Host nginx for BIOMIE v2 (validated with nginx -t; automatic restore on failure).

    python ops/remote.py ops/27_nginx.py harden <release>   # pre-cutover: logged + rate-limited /supabase/
    python ops/remote.py ops/27_nginx.py cutover <release>  # public domain -> v2 (legacy file kept)
    python ops/remote.py ops/27_nginx.py rollback           # public domain -> legacy PHP (no rebuild)
    python ops/remote.py ops/27_nginx.py status
"""
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

SITE = pathlib.Path('/etc/nginx/sites-enabled/biomie.magmoveiscorporativos.com.br')
STORE = pathlib.Path('/opt/biomie-v2/ops/nginx')
ROLLBACK_SITE = STORE / 'legacy-site.conf'
V2_MARKER = '# BIOMIE v2 public site'
STAGING_MARKER = '# BIOMIE V2 API staging'
API_INCLUDE = '    include /etc/nginx/snippets/biomie-v2-api-locations.conf;\n'
INSTALL = {
    'conf.d/biomie-v2.conf': pathlib.Path('/etc/nginx/conf.d/biomie-v2.conf'),
    'snippets/biomie-v2-security-headers.conf': pathlib.Path('/etc/nginx/snippets/biomie-v2-security-headers.conf'),
    'snippets/biomie-v2-proxy.conf': pathlib.Path('/etc/nginx/snippets/biomie-v2-proxy.conf'),
    'snippets/biomie-v2-api-locations.conf': pathlib.Path('/etc/nginx/snippets/biomie-v2-api-locations.conf'),
}
STORE.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')


def nginx_ok():
    p = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    return p.returncode == 0, p.stderr[-1500:]


def reload():
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)


def http(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'biomie-ops-check'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read(4000).decode(errors='replace'), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000).decode(errors='replace'), dict(e.headers)


def apply(changes):
    """changes: {path: new_text or None(delete)}; restores everything if nginx -t fails."""
    backups = {}
    for path, text in changes.items():
        backups[path] = path.read_text() if path.exists() else None
        if backups[path] is not None:
            shutil.copy2(path, STORE / f'{path.name}.{stamp}.bak')
    try:
        for path, text in changes.items():
            path.write_text(text)
        ok, err = nginx_ok()
        if not ok:
            raise RuntimeError(err)
        reload()
    except Exception as error:
        for path, old in backups.items():
            if old is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(old)
        nginx_ok()
        reload()
        raise SystemExit('nginx change reverted: ' + str(error)[-1200:])


def release_dir():
    return pathlib.Path('/opt/biomie-v2/releases') / sys.argv[2] / 'deploy' / 'nginx'


command = sys.argv[1]
if command == 'harden':
    src = release_dir()
    site = SITE.read_text()
    if V2_MARKER in site:
        raise SystemExit('site is already v2; harden applies to the legacy site only')
    changes = {dst: (src / rel).read_text() for rel, dst in INSTALL.items()}
    if STAGING_MARKER in site:
        # Replace the provisional /supabase/ block (marker + one location {...}) by the managed include.
        pattern = re.compile(r'\n[ \t]*' + re.escape(STAGING_MARKER) + r'\n[ \t]*location \^~ /supabase/ \{.*?\n[ \t]*\}\n', re.S)
        site, n = pattern.subn('\n' + API_INCLUDE, site, count=1)
        if n != 1:
            raise SystemExit('staging block not found exactly once')
    elif API_INCLUDE.strip() not in site:
        site = site.replace('    charset utf-8;', '    charset utf-8;\n' + API_INCLUDE, 1)
    changes[SITE] = site
    apply(changes)
    ROLLBACK_SITE.write_text(SITE.read_text())
    status, body, headers = http('https://biomie.magmoveiscorporativos.com.br/supabase/auth/v1/settings')
    admin = http('https://biomie.magmoveiscorporativos.com.br/supabase/auth/v1/admin/users')[0]
    legacy = http('https://biomie.magmoveiscorporativos.com.br/biomie/login.php')[0]
    print(json.dumps({'hardened': True, 'auth_settings': status, 'admin_blocked': admin,
                      'legacy_login_page': legacy, 'csp_on_api': 'Content-Security-Policy' in headers,
                      'rollback_site_saved': str(ROLLBACK_SITE)}, indent=1))
elif command == 'cutover':
    src = release_dir()
    current = SITE.read_text()
    if V2_MARKER in current:
        raise SystemExit('already on v2')
    shutil.copy2(SITE, ROLLBACK_SITE)
    shutil.copy2(SITE, STORE / f'legacy-site.{stamp}.conf')
    changes = {dst: (src / rel).read_text() for rel, dst in INSTALL.items()}
    changes[SITE] = (src / 'sites/biomie-v2.conf').read_text()
    apply(changes)
    status, body, headers = http('https://biomie.magmoveiscorporativos.com.br/auth')
    api = http('https://biomie.magmoveiscorporativos.com.br/supabase/auth/v1/settings')[0]
    jobs = http('https://biomie.magmoveiscorporativos.com.br/api/public/jobs/omie-backfill')[0]
    print(json.dumps({'cutover': True, 'login_page': status, 'is_v2': 'BIOMIE' in body or 'Entrar' in body,
                      'api': api, 'jobs_hidden': jobs, 'csp': headers.get('Content-Security-Policy', '')[:60],
                      'rollback_site': str(ROLLBACK_SITE)}, indent=1))
elif command == 'rollback':
    if not ROLLBACK_SITE.exists():
        raise SystemExit('no saved legacy site')
    apply({SITE: ROLLBACK_SITE.read_text()})
    status = http('https://biomie.magmoveiscorporativos.com.br/biomie/login.php')[0]
    print(json.dumps({'rolled_back': True, 'legacy_login_page': status}, indent=1))
elif command == 'status':
    site = SITE.read_text()
    print(json.dumps({'active': 'v2' if V2_MARKER in site else 'legacy',
                      'api_include': API_INCLUDE.strip() in site,
                      'staging_block': STAGING_MARKER in site,
                      'rollback_saved': ROLLBACK_SITE.exists()}, indent=1))
else:
    raise SystemExit(__doc__)
