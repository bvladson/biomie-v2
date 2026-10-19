import datetime,json,os,pathlib,re,shutil,subprocess

base=pathlib.Path('/opt/biomie-v2')
base.mkdir(mode=0o750,exist_ok=True)
(base/'ops').mkdir(exist_ok=True)
(base/'releases').mkdir(exist_ok=True)
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
backup=pathlib.Path('/var/backups')/('biomie-v2-cutover-'+stamp)
backup.mkdir(mode=0o700)
for src in ['/etc/nginx/sites-enabled/biomie.magmoveiscorporativos.com.br','/etc/cron.d/biomie','/etc/nginx/snippets/biomie-security-headers.conf']:
    if pathlib.Path(src).exists():shutil.copy2(src,backup/pathlib.Path(src).name)
(backup/'legacy-release.txt').write_text(str(pathlib.Path('/var/www/biomie/live').resolve()))
os.chmod(backup/'legacy-release.txt',0o600)
def sql(q):
    p=subprocess.run(['mariadb','--batch','--raw','--skip-column-names','biomie','-e',q],capture_output=True,text=True,check=True)
    return [x.split('\t') for x in p.stdout.splitlines()]
info={}
for table in ['biomie_users','biomie_user_roles','biomie_roles','biomie_user_companies','biomie_company_integrations','biomie_sales_targets_monthly','biomie_sales_target_levels']:
    info[table+'_columns']=sql('SHOW COLUMNS FROM '+table)
info['docker']=subprocess.run(['docker','ps','--format','{{.Names}} {{.Image}}'],capture_output=True,text=True,check=True).stdout
info['legacy_config_paths']={}
for path in ['/var/www/biomie/shared/.env.local.php','/var/www/biomie/live/config/.env.local.php']:
    config=pathlib.Path(path)
    info['legacy_config_paths'][path]=re.findall(r"['\"]([A-Z][A-Z_0-9]+)['\"]\s*=>",config.read_text()) if config.exists() else None
info['companies']=sql('SELECT id,slug,ativo,canal_padrao FROM biomie_companies ORDER BY id')
info['roles']=sql('SELECT * FROM biomie_roles')
info['backup_path']=str(backup)
(base/'ops/inventory.json').write_text(json.dumps(info,indent=2))
(base/'ops/backup_path').write_text(str(backup))
print(json.dumps(info,indent=2))
with (backup/'biomie-final-preparation.sql.gz').open('wb') as f:
    dump=subprocess.Popen(['mariadb-dump','--single-transaction','--quick','--routines','--triggers','--events','--databases','biomie'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    compress=subprocess.run(['gzip','-6'],stdin=dump.stdout,stdout=f,stderr=subprocess.PIPE)
    dump.stdout.close()
    err=dump.stderr.read().decode(errors='replace')
    if dump.wait() or compress.returncode:raise RuntimeError('Database backup failed: '+err[:300])
os.chmod(backup/'biomie-final-preparation.sql.gz',0o600)
subprocess.run(['gzip','-t',str(backup/'biomie-final-preparation.sql.gz')],check=True)
print(json.dumps({'backup_verified_gzip':True,'bytes':(backup/'biomie-final-preparation.sql.gz').stat().st_size,'path':str(backup)}))
