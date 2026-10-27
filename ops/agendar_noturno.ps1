# Registra no Agendador de Tarefas do Windows os trabalhos noturnos da HOMOLOGAÇÃO do BIOMIE
# (parecer de 26/10/2026: não depender de uma sessão do Claude aberta). Rode você mesmo:
#   powershell -ExecutionPolicy Bypass -File ops\agendar_noturno.ps1
# Cria (ou atualiza) tarefas de uma vez só na pasta \BIOMIE\. O computador precisa estar ligado e com o
# usuário conectado no horário. Cada trabalho passa pela janela de testes (fora do expediente, longe das
# cargas, sem leitura de estoque) e grava tudo em ops\logs\noturno\. Nada muda a produção.
# Para remover: Get-ScheduledTask -TaskPath '\BIOMIE\' | Unregister-ScheduledTask -Confirm:$false

$dir = Split-Path -Parent $PSScriptRoot
$python = 'C:\Python314\python.exe'
New-Item -ItemType Directory -Force "$dir\ops\logs\noturno" | Out-Null
$log = "$dir\ops\logs\noturno\agendador.log"
# StartWhenAvailable: se o horário passar com o computador desligado, roda assim que possível; cada passo
# pesado continua esperando a janela de testes (janela_testes.py --esperar), então nada roda no expediente.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun
$jobs = @(
  @{ Name = 'BIOMIE homologacao - Matriz 27-10'; At = '2026-10-27T18:33:00'; Args = 'matriz ba4ee4b03c40 3'
     Desc = 'Teste controlado da correcao da MAG Matriz (tx-probe, homologacao, so leitura no Omie).' },
  @{ Name = 'BIOMIE homologacao - sales_kpis 27-10'; At = '2026-10-27T21:03:00'; Args = 'sales-kpis'
     Desc = 'sales_kpis: diagnostico, testes do banco e comparacao atual x rapido na copia (so leitura).' },
  @{ Name = 'BIOMIE homologacao - Inteligencia 27-10'; At = '2026-10-27T21:35:00'; Args = 'intel 885ff74576cd'
     Desc = 'Inteligencia do Estoque fases 1-5 na homologacao (copia; prazo hipotetico rotulado como teste).' },
  @{ Name = 'BIOMIE homologacao - Fornecedores 27-10'; At = '2026-10-27T21:40:00'; Args = 'intel-fornecedores'
     Desc = 'Fornecedores e prazos (0048/0049): copia nova, ListarProdutoFornecedor so leitura, prazo de teste, motor, navegador. Release: SUPPLIERS_RELEASE do noturno.py.' },
  @{ Name = 'BIOMIE homologacao - Trem 27-10'; At = '2026-10-27T21:45:00'; Args = 'trem'
     Desc = 'Versao combinada (Matriz + sales_kpis + Inteligencia + fornecedores): suites, copia nova, motor, comparacao com a producao, navegador e retorno. Release: TRAIN_RELEASE do noturno.py.' }
)
foreach ($j in $jobs) {
  if ([datetime]$j.At -lt (Get-Date)) { Write-Host "pulado (horario ja passou): $($j.Name)"; continue }
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $dir `
    -Argument "/c $python ops\noturno.py $($j.Args) >> `"$log`" 2>&1"
  $trigger = New-ScheduledTaskTrigger -Once -At ([datetime]$j.At)
  Register-ScheduledTask -TaskName $j.Name -TaskPath '\BIOMIE\' -Action $action -Trigger $trigger `
    -Settings $settings -Description $j.Desc -Force | Out-Null
}
Get-ScheduledTask -TaskPath '\BIOMIE\' -ErrorAction SilentlyContinue | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  '{0} | {1} | proxima execucao {2}' -f $_.TaskName, $_.State, $i.NextRunTime
}
