import datetime,json,os,pathlib,time,urllib.request,urllib.error
base=pathlib.Path('/opt/biomie-v2')
legacy=json.loads((base/'shared/legacy-export.json').read_text())
credential=next(x for x in legacy['credentials'] if int(x['company_id'])==1)
today=datetime.date(2026,10,19)
start=today-datetime.timedelta(days=30)
br=lambda d:d.strftime('%d/%m/%Y')
calls=[('vendors','geral/vendedores/','ListarVendedores',{'pagina':1,'registros_por_pagina':1}),('customers','geral/clientes/','ListarClientes',{'pagina':1,'registros_por_pagina':1,'apenas_importado_api':'N'}),('products','geral/produtos/','ListarProdutos',{'pagina':1,'registros_por_pagina':1,'apenas_importado_api':'N'}),('invoices','produtos/nfconsultar/','ListarNF',{'pagina':1,'registros_por_pagina':1,'dEmiInicial':br(start),'dEmiFinal':br(today)}),('orders','produtos/pedido/','ListarPedidos',{'pagina':1,'registros_por_pagina':1,'apenas_importado_api':'N','filtrar_por_data_de':br(start),'filtrar_por_data_ate':br(today)}),('receivables','financas/contareceber/','ListarContasReceber',{'pagina':1,'registros_por_pagina':1,'apenas_importado_api':'N'}),('settlements','financas/mf/','ListarMovimentos',{'nPagina':1,'nRegPorPagina':1,'cTpLancamento':'CR','dDtPagDe':br(start),'dDtPagAte':br(today)})]
results={}
summary={}
for entity,path,method,params in calls:
    req=urllib.request.Request('https://app.omie.com.br/api/v1/'+path,data=json.dumps({'call':method,'app_key':credential['app_key'],'app_secret':credential['app_secret'],'param':[params]}).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=40) as response:data=json.loads(response.read())
        results[entity]={'status':200,'params':params,'data':data}
        sample=None
        for k,v in data.items():
            if isinstance(v,list) and v and isinstance(v[0],dict):sample=v[0];break
        summary[entity]={'status':200,'top_keys':list(data),'pagination':{k:v for k,v in data.items() if isinstance(v,(int,float))},'sample_keys':list(sample) if sample else [],'nested_keys':{k:list(v) for k,v in (sample or {}).items() if isinstance(v,dict)},'list_item_keys':{k:list(v[0]) for k,v in (sample or {}).items() if isinstance(v,list) and v and isinstance(v[0],dict)}}
    except urllib.error.HTTPError as exc:
        raw=exc.read().decode(errors='replace')
        for secret in credential.values():
            if isinstance(secret,str) and len(secret)>5:raw=raw.replace(secret,'[REDACTED]')
        results[entity]={'status':exc.code,'error':raw[:1000]}
        summary[entity]=results[entity]
    except Exception as exc:
        summary[entity]={'error':type(exc).__name__}
    time.sleep(2)
(base/'shared/omie-validation.json').write_text(json.dumps(results,ensure_ascii=False))
os.chmod(base/'shared/omie-validation.json',0o600)
(base/'ops/omie-validation-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
