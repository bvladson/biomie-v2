import json,pathlib,subprocess
base=pathlib.Path('/opt/biomie-v2')
legacy=json.loads((base/'shared/legacy-export.json').read_text())
maps=json.loads((base/'shared/legacy-map.json').read_text())
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
def lit(v):
    if v is None:return 'NULL'
    if isinstance(v,bool):return 'true' if v else 'false'
    return "'"+str(v).replace("'","''")+"'"
def sql(q):
    p=subprocess.run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-v','ON_ERROR_STOP=1','-At'],input=q,capture_output=True,text=True,timeout=120)
    if p.returncode:raise RuntimeError('Configuration SQL: '+p.stderr.splitlines()[0][:250])
    return p.stdout.strip()
php=r'''<?php
$pdo=new PDO('mysql:unix_socket=/run/mysqld/mysqld.sock;dbname=biomie;charset=utf8mb4','root','',[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$result=[];
foreach(['biomie_vendedores_omie','biomie_clientes_dim','biomie_notas_fiscais_canonicas','biomie_notas_fiscais_itens_canonicos','biomie_pedidos_canonicos','biomie_titulos_financeiros_canonicos'] as $table){$result[$table]=$pdo->query('SELECT * FROM '.$table)->fetchAll(PDO::FETCH_ASSOC);}
echo json_encode($result,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
'''
p=subprocess.run(['php'],input=php,capture_output=True,text=True,check=True,timeout=45)
facts=json.loads(p.stdout)
private=base/'shared/legacy-canonical.json';private.write_text(json.dumps(facts,ensure_ascii=False));private.chmod(0o600)
for access in legacy['biomie_user_companies']:
    uid=maps['users'].get(str(access['user_id']));cid=maps['companies'].get(str(access['company_id']))
    if not uid or not cid:continue
    channels=[]
    if access['can_varejo']:channels.append('varejo')
    if access['can_licitacao']:channels.append('licitacao')
    user=next(x for x in legacy['biomie_users'] if x['id']==access['user_id'])
    sql("INSERT INTO private.legacy_company_access(user_id,company_id,allowed_channels,legacy_role,legacy_role_override) VALUES("+','.join([lit(uid),lit(cid),'ARRAY['+','.join(map(lit,channels))+']::text[]',lit(user['role']),lit(access.get('role_override'))])+") ON CONFLICT(user_id,company_id) DO UPDATE SET allowed_channels=excluded.allowed_channels,legacy_role=excluded.legacy_role,legacy_role_override=excluded.legacy_role_override;")
for company in legacy['companies']:
    key=str(company['id']);cid=maps['companies'][key]
    def owned(records):return [x for x in records if str(x.get('company_id'))==key]
    settings={'company_slug':company['slug'],'default_channel':company['canal_padrao'],'operation_rules':owned(legacy['biomie_operation_scope_rules']),'channel_rules':owned(legacy['biomie_channel_classification_rules']),'vendors':[{'external_id':str(x['codigo_omie']),'name':x['nome']} for x in owned(facts['biomie_vendedores_omie'])],'customers':[{'external_id':str(x['codigo_cliente_omie']),'document_original':x.get('documento_normalizado') or x.get('cpf_cnpj')} for x in owned(facts['biomie_clientes_dim'])],'invoice_overrides':{},'orders_overrides':{},'receivable_overrides':{}}
    for row in owned(facts['biomie_notas_fiscais_canonicas']):
        if not row.get('nota_id_omie'):continue
        settings['invoice_overrides'][str(row['nota_id_omie'])]={'operation_scope':row['operation_scope'],'business_channel':row['business_channel'],'is_biomie_commercial_visible':bool(row['is_biomie_commercial_visible']),'commercial_base_amount':row.get('valor_base_comercial_nf'),'seller_external_id':str(row['codigo_vendedor_omie']) if row['codigo_vendedor_omie'] else None}
    for row in owned(facts['biomie_pedidos_canonicos']):
        settings['orders_overrides'][str(row['pedido_id_omie'])]={'operation_scope':row['operation_scope'],'business_channel':row['business_channel'],'stage_code':row['etapa_omie'],'seller_external_id':str(row['codigo_vendedor_omie']) if row['codigo_vendedor_omie'] else None}
    for row in owned(facts['biomie_titulos_financeiros_canonicos']):
        if not row.get('titulo_id_omie'):continue
        settings['receivable_overrides'][str(row['titulo_id_omie'])]={'business_channel':row['business_channel'],'seller_external_id':str(row['codigo_vendedor_omie']) if row['codigo_vendedor_omie'] else None}
    sql("INSERT INTO private.legacy_classification_config(company_id,settings) VALUES("+lit(cid)+','+lit(json.dumps(settings,ensure_ascii=False))+"::jsonb) ON CONFLICT(company_id) DO UPDATE SET settings=excluded.settings,updated_at=now();")
print(json.dumps({'legacy_access_rows':sum(str(x['user_id']) in maps['users'] for x in legacy['biomie_user_companies']),'companies_configured':len(legacy['companies']),'invoice_classifications_preserved':sum(bool(x.get('nota_id_omie')) for x in facts['biomie_notas_fiscais_canonicas']),'order_classifications_preserved':len(facts['biomie_pedidos_canonicos']),'credentials_and_customer_documents':'not exported from VPS','legacy_canonical_snapshot':'private migration reference only'}))
