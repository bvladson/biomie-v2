import json,os,pathlib,subprocess
base=pathlib.Path('/opt/biomie-v2')
php=r'''<?php
require '/var/www/biomie/live/app/Support/SecretCipher.php';
$environment=require '/var/www/biomie/live/config/.env.local.php';
$cipher=new BIomie\Support\SecretCipher((string)($environment['BIOMIE_SECRET_KEY']??''));
$pdo=new PDO('mysql:unix_socket=/run/mysqld/mysqld.sock;dbname=biomie;charset=utf8mb4','root','',[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$data=[];
foreach(['biomie_users','biomie_user_roles','biomie_roles','biomie_user_companies','biomie_sales_targets_monthly','biomie_sales_target_levels','biomie_company_targets','biomie_data_exclusion_rules','biomie_operation_scope_rules','biomie_channel_classification_rules','biomie_user_seller_scope','biomie_user_visible_sellers'] as $table){
  $data[$table]=$pdo->query('SELECT * FROM '.$table)->fetchAll(PDO::FETCH_ASSOC);
}
$data['companies']=$pdo->query('SELECT id,slug,nome_fantasia,razao_social,ativo,canal_padrao FROM biomie_companies ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
$data['credentials']=[];
foreach($pdo->query("SELECT company_id,app_key,app_secret_encrypted FROM biomie_company_integrations WHERE provider='omie' AND active=1") as $row){
  if(empty($row['app_secret_encrypted']))continue;
  $data['credentials'][]=['company_id'=>$row['company_id'],'app_key'=>$row['app_key'],'app_secret'=>$cipher->decrypt($row['app_secret_encrypted'])];
}
echo json_encode($data,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
'''
p=subprocess.run(['php'],input=php,capture_output=True,text=True,timeout=30)
if p.returncode:raise RuntimeError('Legacy private export failed; details retained only on VPS')
data=json.loads(p.stdout)
target=base/'shared/legacy-export.json'
target.write_text(json.dumps(data,ensure_ascii=False))
os.chmod(target,0o600)
summary={'companies':len(data['companies']),'credentials':len(data['credentials']),'users':len(data['biomie_users']),'users_without_email':sum(not x.get('email') for x in data['biomie_users']),'password_formats':list(set(x['password_hash'][:4] for x in data['biomie_users'])),'legacy_roles':{role:sum(x['role']==role for x in data['biomie_users']) for role in set(x['role'] for x in data['biomie_users'])},'targets':len(data['biomie_sales_targets_monthly']),'privacy':'Private export remains on VPS, mode 0600; no credentials or user records printed'}
(base/'ops/legacy-summary.json').write_text(json.dumps(summary))
print(json.dumps(summary))
