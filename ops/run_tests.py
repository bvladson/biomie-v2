import json,os,pathlib,subprocess,sys
sys.stdout.reconfigure(encoding='utf-8')
root=pathlib.Path(__file__).resolve().parent.parent
data=json.loads((root/'ops/.test-context.json').read_text())
env=os.environ.copy()
env.update({'SUPABASE_URL':'http://127.0.0.1:33140','SUPABASE_SERVICE_ROLE_KEY':data['service'],'SUPABASE_PUBLISHABLE_KEY':data['anon'],'VITE_SUPABASE_URL':'http://127.0.0.1:33140','VITE_SUPABASE_PUBLISHABLE_KEY':data['anon'],'BIOMIE_RLS_E2E':'1'})
p=subprocess.run(['node','node_modules/vitest/vitest.mjs','run'],cwd=root/'source',env=env,capture_output=True,text=True,encoding='utf-8',timeout=420)
log=p.stdout+p.stderr
for key in ['anon','service']:log=log.replace(data[key],'[REDACTED]')
(root/'tests-final.log').write_text(log,encoding='utf-8')
print(log[-8500:])
raise SystemExit(p.returncode)
