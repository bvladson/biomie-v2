import datetime,json,os,pathlib,urllib.request,urllib.error,time
base=pathlib.Path('/opt/biomie-v2')
old=json.loads((base/'shared/omie-validation.json').read_text())
legacy=json.loads((base/'shared/legacy-export.json').read_text())
creds=next(x for x in legacy['credentials'] if int(x['company_id'])==1)
nf=old['invoices']['data']['nfCadastro'][0]
summary={'invoice_evidence':{'cDeneg':nf.get('ide',{}).get('cDeneg'),'tpAmb':nf.get('ide',{}).get('tpAmb'),'dReg_present':bool(nf.get('ide',{}).get('dReg')),'dCan_present':bool(nf.get('ide',{}).get('dCan')),'dInut_present':bool(nf.get('ide',{}).get('dInut')),'key_length':len(nf.get('compl',{}).get('cChaveNFe','')),'seller_title_codes_count':len(set(str(t.get('nCodVendedor')) for t in nf.get('titulos',[]) if t.get('nCodVendedor')))}}
calls=[('products','geral/produtos/','ListarProdutos',{'pagina':1,'registros_por_pagina':1,'apenas_importado_api':'N','filtrar_apenas_omiepdv':'N'}),('settlements','financas/mf/','ListarMovimentos',{'nPagina':1,'nRegPorPagina':1,'cTpLancamento':'BXCR','cNatureza':'R','dDtPagtoDe':'19/09/2026','dDtPagtoAte':'19/10/2026'})]
results={}
for entity,path,method,params in calls:
    request=urllib.request.Request('https://app.omie.com.br/api/v1/'+path,data=json.dumps({'call':method,'app_key':creds['app_key'],'app_secret':creds['app_secret'],'param':[params]}).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=45) as response:data=json.loads(response.read())
        results[entity]={'params':params,'data':data}
        sample=next((v[0] for v in data.values() if isinstance(v,list) and v and isinstance(v[0],dict)),{})
        details=sample.get('detalhes',{})
        resumed=sample.get('resumo',{})
        summary[entity]={'status':200,'top_keys':list(data),'pagination':{k:v for k,v in data.items() if isinstance(v,(int,float))},'sample_keys':list(sample),'nested_keys':{k:list(v) for k,v in sample.items() if isinstance(v,dict)},'semantic_values':{k:details.get(k) for k in ['cTpLancamento','cNatureza','cStatus'] if k in details},'amount_positive':{k:isinstance(details.get(k),(int,float)) and details[k]>0 for k in ['nValorMovCC','nValorTitulo']},'payment_equals_cumulative':details.get('nValorMovCC')==resumed.get('nValPago')}
    except urllib.error.HTTPError as err:
        text=err.read().decode(errors='replace')
        for val in creds.values():
            if isinstance(val,str) and len(val)>5:text=text.replace(val,'[REDACTED]')
        summary[entity]={'status':err.code,'error':text[:400]}
    time.sleep(2)
path=base/'shared/omie-validation-fixed.json';path.write_text(json.dumps(results,ensure_ascii=False));os.chmod(path,0o600)
print(json.dumps(summary,ensure_ascii=False,indent=2))
