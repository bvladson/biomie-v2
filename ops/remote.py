import pathlib, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

BASE=pathlib.Path(__file__).resolve().parent.parent
SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-i',str(pathlib.Path.home()/'.ssh/id_ed25519_vps'),'root@203.0.113.10']
script=pathlib.Path(sys.argv[1])
result=subprocess.run(SSH+['python3 -'],input=script.read_text(encoding='utf-8'),capture_output=True,text=True,encoding='utf-8',timeout=2400)
log=BASE/(script.stem+'.log')
log.write_text(result.stdout+'\n'+result.stderr,encoding='utf-8')
print(result.stdout[-10000:])
if result.stderr:print(result.stderr[-2000:],file=sys.stderr)
raise SystemExit(result.returncode)
