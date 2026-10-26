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
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
$jobs = @(
  @{ Name = 'BIOMIE homologacao - Matriz 26-10'; At = '2026-10-26T18:33:00'; Args = 'matriz ba4ee4b03c40 3'
     Desc = 'Teste controlado da correcao da MAG Matriz (tx-probe, homologacao, so leitura no Omie).' },
  @{ Name = 'BIOMIE homologacao - sales_kpis 26-10'; At = '2026-10-26T21:03:00'; Args = 'sales-kpis'
     Desc = 'Diagnostico de sales_kpis na copia de homologacao (so leitura).' }
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
