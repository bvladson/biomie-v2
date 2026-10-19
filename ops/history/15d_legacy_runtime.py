import pathlib,subprocess
print('OLD_CRON',pathlib.Path('/etc/cron.d/biomie').read_text())
for args in [['systemctl','cat','biomie-python.service'],['systemctl','is-enabled','biomie-python.service'],['docker','stats','--no-stream','--format','{{.Name}} {{.MemUsage}} {{.CPUPerc}}']]:
    p=subprocess.run(args,capture_output=True,text=True,timeout=20)
    print('RUNTIME',p.stdout[-5000:])
