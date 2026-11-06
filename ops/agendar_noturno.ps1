# Registra no Agendador de Tarefas do Windows os trabalhos noturnos da HOMOLOGAÇÃO do BIOMIE
# (parecer de 26/10/2026: não depender de uma sessão do Claude aberta):
#   powershell -ExecutionPolicy Bypass -File ops\agendar_noturno.ps1 [-Release <release>]
# Cria (ou atualiza) tarefas de uma vez só na pasta \BIOMIE\. O computador precisa estar ligado e com o
# usuário conectado no horário: a tarefa roda com o usuário e o perfil dele (o Chromium dos testes de navegador
# fica em %LOCALAPPDATA%\ms-playwright; como SYSTEM ou outro perfil, os testes de navegador falham).
# Cada trabalho passa pela janela de testes (fora do expediente, longe das cargas, sem leitura de estoque),
# respeita os horários da noite (--comecar-ate / --ate do noturno.py) e grava tudo em ops\logs\noturno\.
# Nada muda a produção, exceto o passo 2 do legado (biomie-python.service, autorização de 04/11, com portões).
# Para remover: Get-ScheduledTask -TaskPath '\BIOMIE\' | Unregister-ScheduledTask -Confirm:$false
param([string]$Release = '6ffba8be57a1')

if ($Release -notmatch '^[0-9a-f]{12}$') { throw "release inválida: $Release" }
$dir = Split-Path -Parent $PSScriptRoot
$python = 'C:\Python314\python.exe'
New-Item -ItemType Directory -Force "$dir\ops\logs\noturno" | Out-Null
# StartWhenAvailable: se o horário passar com o computador desligado, roda assim que possível; os horários da
# noite (--comecar-ate) fazem a tarefa desistir sozinha se já for tarde.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun
# Próxima noite: hoje às 18:31 (ou amanhã, se já passou). Sem data fixa no arquivo. A fila do noturno.py é por
# ordem de chegada: as tarefas começam com 1 min de diferença, na ordem da lista.
$quando = (Get-Date).Date.AddHours(18).AddMinutes(31)
if ((Get-Date) -gt $quando) { $quando = $quando.AddDays(1) }
$rotulo = $quando.ToString('dd-MM')
# Noite de 06/11/2026 (combinado com o MAG AI, que instala em 07/11 00:30): nada começa depois das 23:00 e a
# cópia é desligada até 23:30; validação que não começou até 21:00 fica para outra noite.
$jobs = @(
  @{ Key = 'legado-passo2'; Name = "BIOMIE legado - passo 2 $rotulo"; At = $quando
     Args = 'legado-passo2 --comecar-ate=21:45 --ate=22:00'
     Desc = 'Desativacao do BIomie antigo, passo 2: biomie-python.service parado e fora do boot, com portoes (passo 1 feito, nenhuma requisicao em 24 h, nenhuma conexao, nenhuma rota do nginx, nenhum codigo chamando). Nada e apagado. Retorno: 54_legado.py desfazer-parar-python.' }
  @{ Key = 'plano'; Name = "BIOMIE homologacao - Plano $Release $rotulo"; At = $quando.AddMinutes(1)
     Args = "plano $Release --comecar-ate=21:00 --ate=23:00"
     Desc = 'Validacao do Plano de Voo na copia (homologacao) da release candidata: suites, copia nova, foto antes/depois, 56, 57, navegador do Plano, regressao, Estoque e retorno. A ativacao NAO e automatica.' }
  @{ Key = 'intel-fornecedores'; Name = "BIOMIE homologacao - Fornecedores $Release $rotulo"; At = $quando.AddMinutes(2)
     Args = "intel-fornecedores $Release --comecar-ate=21:00 --ate=23:00"
     Desc = 'Validacao do Estoque (Inteligencia + fornecedores) na copia da release candidata: suites, copia nova, foto, fornecedores do Omie (so leitura), motor, conferencia 43, navegador, DESFAZER da importacao na copia e retorno. A ativacao NAO e automatica.' }
)
# Tarefas de outras noites (rodam uma vez só) saem da lista.
Get-ScheduledTask -TaskPath '\BIOMIE\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -notlike "*$rotulo" } |
  Unregister-ScheduledTask -Confirm:$false
foreach ($j in $jobs) {
  if ([datetime]$j.At -lt (Get-Date)) { Write-Host "pulado (horario ja passou): $($j.Name)"; continue }
  $log = "$dir\ops\logs\noturno\agendador-$($j.Key).log"
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $dir `
    -Argument "/c set PYTHONIOENCODING=utf-8&& $python ops\noturno.py $($j.Args) >> `"$log`" 2>&1"
  $trigger = New-ScheduledTaskTrigger -Once -At ([datetime]$j.At)
  Register-ScheduledTask -TaskName $j.Name -TaskPath '\BIOMIE\' -Action $action -Trigger $trigger `
    -Settings $settings -Description $j.Desc -Force | Out-Null
}
Get-ScheduledTask -TaskPath '\BIOMIE\' -ErrorAction SilentlyContinue | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  '{0} | {1} | {2} | proxima execucao {3}' -f $_.TaskName, $_.State, $_.Principal.UserId, $i.NextRunTime
}
