"""BIomie ANTIGO (legado): cópias de segurança e preparação da desativação (autorização do usuário de 03/11/2026:
"corrigir a dependência do backup novo e adotar medidas para impedir novos envios de cópias sem criptografia,
preservando a capacidade de recuperação"; NÃO autoriza excluir dados, bancos ou volumes do legado).

    python ops/remote.py ops/54_legado.py status                     # só leitura
    python ops/remote.py ops/54_legado.py backup-v2                  # backup do v2 sem depender do legado
    python ops/remote.py ops/54_legado.py arquivo-cifrado            # arquivo final CIFRADO do banco antigo
    python ops/remote.py ops/54_legado.py parar-texto-puro           # desliga só o dump sem cifra das 03:00
    python ops/remote.py ops/54_legado.py desfazer-parar-texto-puro  # religa aquela linha
    python ops/remote.py ops/54_legado.py desfazer-backup-v2         # volta o backup.py anterior
    python ops/remote.py ops/54_legado.py testar-restauracao         # arquivo cifrado novo restaurado num MariaDB
                                                                     # descartável (sem rede) e contado tabela a tabela

backup-v2: grava /opt/biomie-v2/shared/offsite.conf (HOST, PORT, USER e o CAMINHO da chave; nenhum segredo) com o
mesmo destino que o backup.py hoje lê de dentro do script antigo, instala o backup.py da release ativa (a versão
que lê o offsite.conf; a atual fica guardada em bin/backup.py.antes-<data>) e roda um backup real com a cópia
externa conferida por sha256. Se o backup não confirmar a cópia externa pelo offsite.conf, volta sozinho o
backup.py anterior.

arquivo-cifrado: dump consistente do banco antigo (mariadb-dump --single-transaction, como o db_backup.sh) →
gzip → gpg AES256 com a frase-senha do backup do v2, tudo em fluxo: nada em texto puro toca o disco. Conferido
decifrando de novo (marcador "Dump completed" e o número de tabelas do banco), guardado em
/var/backups/biomie-v2/legado/ e copiado para fora (backups/biomie-legado-cifrado/, sha256 dos dois lados).

parar-texto-puro: só com arquivo cifrado conferido nas últimas 12 h (inclusive a cópia externa); comenta somente a linha do
db_backup.sh em /etc/cron.d/biomie (cópia do arquivo em /root/backups). As outras tarefas do legado continuam.
As cópias antigas em texto puro (15 locais, ~30 na Hostinger) ficam como estão: apagar é outra autorização.
"""
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
PASSPHRASE = BASE / 'shared' / 'backup.passphrase'
OFFSITE_CONF = BASE / 'shared' / 'offsite.conf'
BACKUP_PY = BASE / 'bin' / 'backup.py'
LEGACY_SCRIPT = pathlib.Path('/var/www/biomie/live/cron/hostinger/db_backup.sh')
LEGACY_CRON = pathlib.Path('/etc/cron.d/biomie')
CRON_COPIES = pathlib.Path('/root/backups')
ARCHIVE_DIR = pathlib.Path('/var/backups/biomie-v2/legado')
LEGACY_DUMPS = pathlib.Path('/var/backups/biomie')
OFFSITE_ARCHIVE_DIR = 'backups/biomie-legado-cifrado'
DB = 'biomie'
MARKER = '# DESLIGADO 03/11/2026 (copia SEM cifra para fora; ops/54_legado.py parar-texto-puro): '
GPG_ENCRYPT = ['gpg', '--batch', '--yes', '--quiet', '--pinentry-mode', 'loopback', '--symmetric',
               '--cipher-algo', 'AES256', '--s2k-digest-algo', 'SHA512', '--s2k-mode', '3', '--s2k-count', '65011712',
               '--compress-algo', 'none']


def now():
    return dt.datetime.now(dt.timezone.utc)


def stamp():
    return now().strftime('%Y%m%dT%H%M%SZ')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(cmd, timeout=600, check=True, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout, **kw)
    if check and p.returncode:
        raise SystemExit(f"FALHOU {' '.join(cmd[:3])}: {(p.stderr or p.stdout)[-600:]}")
    return p


# --------------------------------------------------------------------------- destino externo
def legacy_offsite(text):
    """Destino externo escrito no script antigo (a mesma leitura que o backup.py faz hoje)."""
    values = {}
    for key in ('HOST', 'PORT', 'USER', 'KEY'):
        m = re.search(r'^OFFSITE_' + key + r'="\$\{BIOMIE_OFFSITE_' + key + r':-([^}]*)\}"', text, re.M)
        if m:
            values[key] = m.group(1)
    return values


def read_conf(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.strip().partition('=')
            if sep and key in ('HOST', 'PORT', 'USER', 'KEY'):
                values[key] = value.strip().strip('"')
    return values


def offsite_cfg():
    cfg = read_conf(OFFSITE_CONF) or (legacy_offsite(LEGACY_SCRIPT.read_text()) if LEGACY_SCRIPT.exists() else {})
    if len(cfg) != 4 or not pathlib.Path(cfg['KEY']).is_file():
        raise SystemExit('destino externo não configurado (offsite.conf ou script antigo)')
    return cfg


def ssh(cfg, command, timeout=300):
    return run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new',
                '-i', cfg['KEY'], '-p', cfg['PORT'], f"{cfg['USER']}@{cfg['HOST']}", command], timeout=timeout)


def send(cfg, path, remote_dir):
    """Cópia para fora com nome provisório, sha256 do outro lado e só então o nome final (como o backup.py)."""
    ssh(cfg, f"mkdir -p '{remote_dir}' && chmod 700 '{remote_dir}'")
    partial = f'{remote_dir}/{path.name}.partial'
    run(['scp', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new',
         '-i', cfg['KEY'], '-P', cfg['PORT'], '-q', str(path), f"{cfg['USER']}@{cfg['HOST']}:{partial}"], timeout=3600)
    remote = ssh(cfg, f"sha256sum '{partial}' | cut -d' ' -f1").stdout.strip()
    local = sha256(path)
    if remote != local:
        ssh(cfg, f"rm -f '{partial}'")
        raise SystemExit('cópia externa com sha256 diferente: removida')
    ssh(cfg, f"mv '{partial}' '{remote_dir}/{path.name}'")
    return {'host': cfg['HOST'], 'dir': remote_dir, 'file': path.name, 'sha256': remote, 'verified': True}


# --------------------------------------------------------------------------- cron do legado
def cron_lines(text):
    """(número, linha) das tarefas ativas do cron (sem comentários nem variáveis)."""
    out = []
    for i, line in enumerate(text.splitlines()):
        s = line.strip()
        if s and not s.startswith('#') and not re.match(r'^[A-Z_][A-Z0-9_]*=', s):
            out.append((i, line))
    return out


def comment_db_backup(text):
    """Comenta só as linhas ATIVAS que chamam o db_backup.sh. Devolve (texto novo, quantas)."""
    lines, changed = text.splitlines(keepends=True), 0
    active = {i for i, _ in cron_lines(text)}
    for i, line in enumerate(lines):
        if i in active and 'db_backup.sh' in line:
            lines[i] = MARKER + line
            changed += 1
    return ''.join(lines), changed


def uncomment_db_backup(text):
    lines, changed = text.splitlines(keepends=True), 0
    for i, line in enumerate(lines):
        if line.startswith(MARKER):
            lines[i] = line[len(MARKER):]
            changed += 1
    return ''.join(lines), changed


def write_atomic(path, text, mode=0o644):
    tmp = path.with_name('.' + path.name + '.novo')
    tmp.write_text(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- comandos
def status():
    cron = LEGACY_CRON.read_text() if LEGACY_CRON.exists() else ''
    active = cron_lines(cron)
    dumps = sorted(LEGACY_DUMPS.glob('biomie-*.sql.gz')) if LEGACY_DUMPS.exists() else []
    archives = sorted(ARCHIVE_DIR.glob('*.json')) if ARCHIVE_DIR.exists() else []
    release = dict(l.split('=', 1) for l in ENV.read_text().splitlines() if '=' in l).get('RELEASE_ID')
    release_backup = BASE / 'releases' / str(release) / 'deploy' / 'vps' / 'backup.py'
    out = {
        'legacyCron': {'activeJobs': len(active),
                       'dbBackupActive': any('db_backup.sh' in l for _, l in active),
                       'dbBackupDisabledByUs': MARKER in cron},
        'legacyPlaintextDumps': {'count': len(dumps), 'newest': dumps[-1].name if dumps else None,
                                 'gb': round(sum(p.stat().st_size for p in dumps) / 1024 ** 3, 2)},
        'encryptedArchives': [json.loads(p.read_text()) for p in archives][-3:],
        'v2Backup': {'installedSha256': sha256(BACKUP_PY) if BACKUP_PY.exists() else None,
                     'releaseSha256': sha256(release_backup) if release_backup.exists() else None,
                     'installedReadsOffsiteConf': BACKUP_PY.exists() and 'OFFSITE_CONF' in BACKUP_PY.read_text(),
                     'offsiteConf': read_conf(OFFSITE_CONF) or None,
                     'savedPrevious': sorted(p.name for p in BACKUP_PY.parent.glob('backup.py.antes-*'))},
        'mariadb': run(['mysql', '-N', '-e', "select count(*), round(sum(data_length + index_length) / 1048576) "
                        f"from information_schema.tables where table_schema = '{DB}' and table_type = 'BASE TABLE'"],
                       check=False).stdout.strip(),
    }
    try:
        cfg = offsite_cfg()
        listing = ssh(cfg, "for d in backups/biomie-db backups/biomie-legado-cifrado backups/biomie-v2-db; do "
                           "n=$(ls \"$d\" 2>/dev/null | grep -vc '\\.partial$'); s=$(du -sh \"$d\" 2>/dev/null | cut -f1); "
                           "l=$(ls -1 \"$d\" 2>/dev/null | sort | tail -1); echo \"$d|$n|$s|$l\"; done").stdout
        out['offsite'] = [dict(zip(('dir', 'files', 'size', 'newest'), l.split('|'))) for l in listing.splitlines()]
    except SystemExit as error:
        out['offsite'] = str(error)
    return out


def backup_v2():
    legacy = legacy_offsite(LEGACY_SCRIPT.read_text()) if LEGACY_SCRIPT.exists() else {}
    current = read_conf(OFFSITE_CONF)
    target = current or legacy
    if len(target) != 4 or not pathlib.Path(target['KEY']).is_file():
        raise SystemExit('destino externo do script antigo incompleto: nada mudou')
    wrote = False
    if not current:
        fd = os.open(OFFSITE_CONF, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write('# Destino externo do backup do v2 (ops/54_legado.py, 03/11/2026). KEY = caminho da chave.\n'
                         + ''.join(f'{k}={target[k]}\n' for k in ('HOST', 'PORT', 'USER', 'KEY')))
        wrote = True
    release = dict(l.split('=', 1) for l in ENV.read_text().splitlines() if '=' in l)['RELEASE_ID']
    source = BASE / 'releases' / release / 'deploy' / 'vps' / 'backup.py'
    if 'OFFSITE_CONF' not in source.read_text():
        raise SystemExit(f'o backup.py da release {release} ainda não lê o offsite.conf: nada instalado')
    saved = None
    if sha256(source) != sha256(BACKUP_PY):
        saved = BACKUP_PY.with_name(f'backup.py.antes-{stamp()}')
        shutil.copy2(BACKUP_PY, saved)
        os.chmod(saved, 0o600)
        shutil.copy2(source, BACKUP_PY)
        os.chmod(BACKUP_PY, 0o700)
    p = run(['python3', str(BACKUP_PY), 'run'], timeout=3600, check=False)
    events = [json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')]
    offsite = next((e for e in events if e.get('event') == 'offsite_complete'), None)
    ok = p.returncode == 0 and offsite is not None and offsite.get('config') == 'offsite.conf'
    restored = False
    if not ok and saved:
        shutil.copy2(saved, BACKUP_PY)
        os.chmod(BACKUP_PY, 0o700)
        restored = True
    return {'ok': ok, 'offsiteConf': {'written': wrote, 'values': read_conf(OFFSITE_CONF),
                                      'sameAsLegacyScript': read_conf(OFFSITE_CONF) == legacy},
            'release': release, 'installed': sha256(BACKUP_PY), 'previousSavedAs': str(saved) if saved else None,
            'previousRestored': restored, 'backupExit': p.returncode, 'events': events,
            'error': None if ok else (p.stderr[-800:] or 'cópia externa não confirmada pelo offsite.conf')}


def archive():
    if shutil.disk_usage('/var/backups').free < 8 * 1024 ** 3:
        raise SystemExit('menos de 8 GB livres: arquivo não gerado')
    if not PASSPHRASE.exists():
        raise SystemExit('frase-senha do backup do v2 ausente')
    tables = int(run(['mysql', '-N', '-e', "select count(*) from information_schema.tables "
                      f"where table_schema = '{DB}' and table_type = 'BASE TABLE'"]).stdout.strip())
    ARCHIVE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(ARCHIVE_DIR, 0o700)
    name = f'biomie-legado-{stamp()}.sql.gz.gpg'
    partial, final = ARCHIVE_DIR / ('.partial-' + name), ARCHIVE_DIR / name
    started = now()
    dump_bin = 'mariadb-dump' if shutil.which('mariadb-dump') else 'mysqldump'
    errors = ARCHIVE_DIR / f'.erros-{stamp()}.txt'  # avisos do dump num arquivo: um cano cheio travaria o fluxo
    procs = []
    try:
        with open(errors, 'wb') as err:
            dump = subprocess.Popen([dump_bin, '--single-transaction', '--quick', '--routines', '--events', '--triggers',
                                     '--default-character-set=utf8mb4', DB], stdout=subprocess.PIPE, stderr=err)
            gz = subprocess.Popen(['gzip', '-c'], stdin=dump.stdout, stdout=subprocess.PIPE, stderr=err)
            dump.stdout.close()
            enc = subprocess.Popen(GPG_ENCRYPT + ['--passphrase-file', str(PASSPHRASE), '-o', str(partial)],
                                   stdin=gz.stdout, stderr=err)
            gz.stdout.close()
            procs = [dump, gz, enc]
            enc.wait(timeout=1800)
            gz.wait(timeout=120)
            dump.wait(timeout=120)
    except subprocess.TimeoutExpired:
        for p in procs:
            p.kill()
        partial.unlink(missing_ok=True)
        raise SystemExit('dump do banco antigo passou de 30 minutos: interrompido, nada desligado')
    messages = errors.read_text(errors='replace')[-400:]
    errors.unlink(missing_ok=True)
    if dump.returncode or gz.returncode or enc.returncode:
        partial.unlink(missing_ok=True)
        raise SystemExit(f'dump/compressão/cifra falharam ({dump.returncode}/{gz.returncode}/{enc.returncode}): '
                         + messages)
    os.chmod(partial, 0o600)
    # Conferência: decifra de novo em fluxo e lê o SQL sem gravá-lo (marcador final e tabelas criadas).
    dec = subprocess.Popen(['gpg', '--batch', '--quiet', '--pinentry-mode', 'loopback', '--passphrase-file',
                            str(PASSPHRASE), '-d', str(partial)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    gunz = subprocess.Popen(['gzip', '-dc'], stdin=dec.stdout, stdout=subprocess.PIPE)
    dec.stdout.close()
    created, tail, size = 0, [], 0
    for line in gunz.stdout:
        size += len(line)
        if line.startswith(b'CREATE TABLE'):
            created += 1
        tail = (tail + [line])[-3:]
    gunz.wait(timeout=600)
    dec.wait(timeout=600)
    completed = any(b'Dump completed' in l for l in tail)
    ok_local = dec.returncode == 0 and gunz.returncode == 0 and completed and created == tables
    if not ok_local:
        partial.unlink(missing_ok=True)
        raise SystemExit(f'conferência do arquivo cifrado falhou: tabelas {created}/{tables}, '
                         f'marcador final {completed}, decifra {dec.returncode}, gzip {gunz.returncode}')
    os.replace(partial, final)
    manifest = {'file': str(final), 'bytes': final.stat().st_size, 'sha256': sha256(final),
                'createdUtc': started.isoformat(timespec='seconds'), 'database': DB, 'tables': tables,
                'createTableStatements': created, 'dumpCompleted': completed, 'sqlBytes': size,
                'encryption': 'gpg AES256 (frase-senha do backup do v2: /opt/biomie-v2/shared/backup.passphrase)',
                'restore': f'gpg -d {final.name} | gzip -dc | mariadb <banco de teste>'}
    manifest['offsite'] = send(offsite_cfg(), final, OFFSITE_ARCHIVE_DIR)
    manifest['ok'] = manifest['offsite']['sha256'] == manifest['sha256']
    path = final.with_name(final.name + '.json')
    path.write_text(json.dumps(manifest, indent=1))
    os.chmod(path, 0o600)
    return manifest


def recent(iso, hours=12):
    try:
        return now() - dt.datetime.fromisoformat(iso) < dt.timedelta(hours=hours)
    except (TypeError, ValueError):
        return False


def stop_plaintext():
    verified = []
    for path in sorted(ARCHIVE_DIR.glob('*.json')) if ARCHIVE_DIR.exists() else []:
        m = json.loads(path.read_text())
        if (m.get('ok') and recent(m.get('createdUtc')) and (m.get('offsite') or {}).get('verified')
                and pathlib.Path(m['file']).exists() and sha256(m['file']) == m['sha256']):
            verified.append(m)
    if not verified:
        raise SystemExit('sem arquivo cifrado conferido nas últimas 12 h (local e cópia externa): nada desligado')
    before = LEGACY_CRON.read_text()
    new, changed = comment_db_backup(before)
    if not changed:
        return {'ok': True, 'alreadyStopped': True, 'archive': verified[-1]['file']}
    CRON_COPIES.mkdir(mode=0o700, parents=True, exist_ok=True)
    copy = CRON_COPIES / f'cron.d-biomie-{stamp()}'
    copy.write_text(before)
    os.chmod(copy, 0o600)
    write_atomic(LEGACY_CRON, new)
    after = LEGACY_CRON.read_text()
    still = [l for _, l in cron_lines(after) if 'db_backup.sh' in l]
    others_before = [l for _, l in cron_lines(before) if 'db_backup.sh' not in l]
    others_after = [l for _, l in cron_lines(after) if 'db_backup.sh' not in l]
    return {'ok': not still and others_before == others_after, 'commentedLines': changed, 'copy': str(copy),
            'sha256Before': hashlib.sha256(before.encode()).hexdigest(),
            'sha256After': hashlib.sha256(after.encode()).hexdigest(),
            'otherJobsUnchanged': others_before == others_after, 'activeJobsNow': len(cron_lines(after)),
            'archive': verified[-1]['file']}


def undo_stop():
    new, changed = uncomment_db_backup(LEGACY_CRON.read_text())
    if changed:
        write_atomic(LEGACY_CRON, new)
    return {'restoredLines': changed, 'dbBackupActive': any('db_backup.sh' in l for _, l in cron_lines(new))}


RESTORE_CONTAINER = 'biomie-legado-restauracao'
RESTORE_IMAGE = 'mariadb:11.8'  # a mesma versão do servidor (11.8.8); a imagem já existe (outros sistemas a usam)


def count_sql(schema, tables):
    """Contagem exata de todas as tabelas num único retrato (transação com snapshot consistente)."""
    parts = [f"select '{t}', count(*) from `{schema}`.`{t}`" for t in tables]
    return 'start transaction with consistent snapshot;\n' + '\nunion all\n'.join(parts) + ';\ncommit;\n'


def parse_counts(text):
    out = {}
    for line in text.splitlines():
        name, sep, value = line.partition('\t')
        if sep and value.strip().isdigit():
            out[name] = int(value)
    return out


def live_tables():
    names = run(['mariadb', '-N', '-e', "select table_name from information_schema.tables "
                 f"where table_schema = '{DB}' and table_type = 'BASE TABLE' order by 1"]).stdout.split()
    if any(not re.fullmatch(r'[A-Za-z0-9_]{1,64}', n) for n in names):
        raise SystemExit('nome de tabela inesperado no banco antigo: teste não iniciado')
    return names


def live_counts(tables):
    return parse_counts(run(['mariadb', '-N', DB], input=count_sql(DB, tables), timeout=900).stdout)


def compare_counts(before, after, restored):
    """Tabela que não mudou durante o dump (antes = depois) tem de voltar com o mesmo número de linhas;
    tabela que mudou no meio fica listada (o dump é um retrato de um instante entre as duas contagens)."""
    missing = sorted(set(before) - set(restored))
    extra = sorted(set(restored) - set(before))
    changed = {t: [before[t], after.get(t)] for t in before if after.get(t) != before[t]}
    wrong = {t: {'banco': before[t], 'restaurado': restored.get(t)} for t in before
             if t not in changed and t in restored and restored[t] != before[t]}
    between = {t: v for t, v in changed.items() if restored.get(t) is not None
               and min(v[0], v[1] if v[1] is not None else v[0]) <= restored[t] <= max(v[0], v[1] if v[1] is not None else v[0])}
    return {'ok': not missing and not extra and not wrong, 'tables': len(before), 'restoredTables': len(restored),
            'rowsLive': sum(before.values()), 'rowsRestored': sum(restored.values()),
            'missing': missing, 'extra': extra, 'different': wrong,
            'changedDuringDump': {t: {'antes': v[0], 'depois': v[1], 'restaurado': restored.get(t),
                                      'entre': t in between} for t, v in changed.items()}}


def restore_test():
    """Teste de restauração (preparação da desativação, 03/11/2026): contagem exata do banco antigo → arquivo
    cifrado NOVO (o mesmo arquivo-cifrado) → contagem de novo → restauração desse arquivo num MariaDB descartável
    (sem rede, 1 CPU, 2 GB) → contagem do restaurado e comparação. O contêiner e o volume são apagados no fim."""
    busy_until = now() + dt.timedelta(minutes=5)
    while run(['pgrep', '-f', '/var/www/biomie/live/cron/hostinger/'], check=False).returncode == 0:
        if now() > busy_until:
            raise SystemExit('tarefa do legado rodando há mais de 5 min: teste adiado (nada mudou)')
        subprocess.run(['sleep', '20'])
    tables = live_tables()
    before = live_counts(tables)
    manifest = archive()
    after = live_counts(tables)
    final = pathlib.Path(manifest['file'])
    timeline = {'countsBefore': len(before), 'archive': final.name}
    run(['docker', 'rm', '-fv', RESTORE_CONTAINER], check=False)
    try:
        run(['docker', 'run', '-d', '--name', RESTORE_CONTAINER, '--network', 'none', '--cpus', '1', '--memory', '2g',
             '-e', 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1', '-e', 'MARIADB_DATABASE=restaurado', RESTORE_IMAGE,
             '--innodb-buffer-pool-size=768M', '--skip-log-bin'], timeout=300)
        ready = False
        for _ in range(60):
            if run(['docker', 'exec', RESTORE_CONTAINER, 'healthcheck.sh', '--connect', '--innodb_initialized'],
                   check=False, timeout=30).returncode == 0:
                ready = True
                break
            subprocess.run(['sleep', '5'])
        if not ready:
            raise SystemExit('MariaDB descartável não ficou pronto em 5 min')
        started = now()
        errors = ARCHIVE_DIR / f'.erros-restauracao-{stamp()}.txt'
        with open(errors, 'wb') as err:
            dec = subprocess.Popen(['gpg', '--batch', '--quiet', '--pinentry-mode', 'loopback', '--passphrase-file',
                                    str(PASSPHRASE), '-d', str(final)], stdout=subprocess.PIPE, stderr=err)
            gunz = subprocess.Popen(['gzip', '-dc'], stdin=dec.stdout, stdout=subprocess.PIPE, stderr=err)
            dec.stdout.close()
            load = subprocess.Popen(['docker', 'exec', '-i', RESTORE_CONTAINER, 'mariadb', '-uroot',
                                     '--max-allowed-packet=1073741824', 'restaurado'], stdin=gunz.stdout, stderr=err,
                                    stdout=subprocess.DEVNULL)
            gunz.stdout.close()
            try:
                load.wait(timeout=75 * 60)
                gunz.wait(timeout=120)
                dec.wait(timeout=120)
            except subprocess.TimeoutExpired:
                for p in (load, gunz, dec):
                    p.kill()
                raise SystemExit('restauração passou de 75 minutos: interrompida (contêiner apagado)')
        messages = errors.read_text(errors='replace')[-600:]
        errors.unlink(missing_ok=True)
        timeline['importSeconds'] = round((now() - started).total_seconds())
        if load.returncode or gunz.returncode or dec.returncode:
            raise SystemExit(f'restauração falhou (mariadb {load.returncode}, gzip {gunz.returncode}, '
                             f'gpg {dec.returncode}): {messages}')
        restored_tables = run(['docker', 'exec', RESTORE_CONTAINER, 'mariadb', '-uroot', '-N', '-e',
                               "select table_name from information_schema.tables where table_schema = 'restaurado' "
                               "and table_type = 'BASE TABLE' order by 1"]).stdout.split()
        restored = parse_counts(run(['docker', 'exec', '-i', RESTORE_CONTAINER, 'mariadb', '-uroot', '-N', 'restaurado'],
                                    input=count_sql('restaurado', restored_tables), timeout=900).stdout)
        size = run(['docker', 'exec', RESTORE_CONTAINER, 'mariadb', '-uroot', '-N', '-e',
                    "select round(sum(data_length + index_length) / 1048576) from information_schema.tables "
                    "where table_schema = 'restaurado'"]).stdout.strip()
    finally:
        run(['docker', 'rm', '-fv', RESTORE_CONTAINER], check=False)
    result = compare_counts(before, after, restored)
    result.update({'archive': manifest, 'restoredMb': size, 'timeline': timeline,
                   'container': {'image': RESTORE_IMAGE, 'network': 'none', 'removed': True},
                   'warnings': messages.strip()[-300:] or None})
    path = final.with_name(final.name + '.restauracao.json')
    path.write_text(json.dumps({k: v for k, v in result.items() if k != 'archive'}, indent=1, default=str))
    os.chmod(path, 0o600)
    return result


def undo_backup_v2():
    saved = sorted(BACKUP_PY.parent.glob('backup.py.antes-*'))
    if not saved:
        raise SystemExit('nenhuma cópia do backup.py anterior')
    shutil.copy2(saved[-1], BACKUP_PY)
    os.chmod(BACKUP_PY, 0o700)
    return {'restoredFrom': str(saved[-1]), 'installed': sha256(BACKUP_PY)}


COMMANDS = {'status': status, 'backup-v2': backup_v2, 'arquivo-cifrado': archive, 'parar-texto-puro': stop_plaintext,
            'desfazer-parar-texto-puro': undo_stop, 'desfazer-backup-v2': undo_backup_v2,
            'testar-restauracao': restore_test}

if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if command not in COMMANDS:
        raise SystemExit(__doc__)
    print(json.dumps(COMMANDS[command](), indent=1, ensure_ascii=False, default=str))
