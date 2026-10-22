<#
.SYNOPSIS
  Instala o BenURA como serviço do Windows: sobe sozinho quando o PC liga, mesmo sem
  ninguém logado, e volta sozinho se o PM2 cair.

.DESCRIPTION
  1. Sobe os serviços do BenURA no PM2 (ecosystem.config.js) e salva a lista (pm2 save).
  2. Cria a tarefa "BenURA" no Agendador de Tarefas, com o usuário do Windows (pede a senha):
     - ao ligar o PC (1 min depois): restaura os serviços salvos (pm2 resurrect);
     - a cada 5 min (o vigia): se o PM2 caiu ou perdeu a lista, restaura de novo.
  O vigia respeita o "Desligar automação" do painel: serviço parado continua parado.
  Pode rodar de novo quando quiser (atualiza a tarefa, não duplica nada).

.PARAMETER ComAtualizador
  Também sobe o atualizador automático (ecosystem.atualizador.config.js).

.PARAMETER SemVigia
  Só restaura ao ligar o PC (sem a conferência a cada 5 min).

.EXAMPLE
  # No PowerShell como administrador, na pasta do BenURA:
  powershell -ExecutionPolicy Bypass -File scripts\windows\instalar-servico.ps1 -ComAtualizador
#>
[CmdletBinding()]
param(
  [string]$Pasta = (Resolve-Path ([IO.Path]::Combine($PSScriptRoot, '..', '..'))).Path,
  [switch]$ComAtualizador,
  [switch]$SemVigia
)

$ErrorActionPreference = 'Stop'
$NomeTarefa = 'BenURA'
function Passo([string]$texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Falhar([string]$texto) { Write-Host "`nERRO: $texto" -ForegroundColor Red; exit 1 }

Passo 'Conferindo o PC'
$identidade = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identidade.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Falhar 'Abra o PowerShell como administrador (botão direito → "Executar como administrador") e rode de novo.'
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Falhar 'Node.js não encontrado. Instale com: winget install OpenJS.NodeJS.LTS (e abra o PowerShell de novo).' }
$pm2 = [IO.Path]::Combine($Pasta, 'node_modules', 'pm2', 'bin', 'pm2')
if (-not (Test-Path $pm2)) { Falhar "PM2 não encontrado em $pm2. Rode 'npm ci' na pasta $Pasta." }
if (-not (Test-Path (Join-Path $Pasta '.env'))) {
  Write-Warning "Não achei o .env em $Pasta. Sem ele os serviços não sobem (copie de .env.example ou do PC antigo)."
}
Write-Host "Pasta do BenURA: $Pasta"
Write-Host "Node: $node ($(& $node -v))"

Passo 'Subindo os serviços no PM2'
Push-Location $Pasta
try {
  & $node $pm2 startOrRestart ecosystem.config.js
  if ($LASTEXITCODE -ne 0) { Falhar 'O PM2 não conseguiu subir os serviços (veja acima).' }
  if ($ComAtualizador) {
    & $node $pm2 startOrRestart ecosystem.atualizador.config.js
    if ($LASTEXITCODE -ne 0) { Falhar 'O PM2 não conseguiu subir o atualizador (veja acima).' }
  }
  # A lista salva é o que volta ao ligar o PC.
  & $node $pm2 save --force
  if ($LASTEXITCODE -ne 0) { Falhar 'O PM2 não conseguiu salvar a lista de serviços.' }
} finally {
  Pop-Location
}

Passo "Criando a tarefa ""$NomeTarefa"" no Agendador de Tarefas"
$usuario = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "A tarefa roda como $usuario (o mesmo usuário que usa o 'npx pm2' neste PC)."
$credencial = Get-Credential -UserName $usuario -Message 'Senha deste usuário do Windows: o BenURA sobe com ele mesmo sem ninguém logado'
if (-not $credencial) { Falhar 'Sem a senha não dá para criar a tarefa.' }

$vigia = [IO.Path]::Combine($Pasta, 'scripts', 'windows', 'vigia-pm2.ps1')
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Pasta `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$vigia`" -Pasta `"$Pasta`""
$aoLigar = New-ScheduledTaskTrigger -AtStartup
$aoLigar.Delay = 'PT1M' # a rede e o disco já estão prontos
$gatilhos = @($aoLigar)
if (-not $SemVigia) {
  # A cada 5 min, para sempre (sem -RepetitionDuration = sem fim).
  $gatilhos += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
}
$opcoes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

try {
  Register-ScheduledTask -TaskName $NomeTarefa -Action $acao -Trigger $gatilhos -Settings $opcoes `
    -User $usuario -Password $credencial.GetNetworkCredential().Password -RunLevel Highest -Force `
    -Description 'BenURA: restaura os serviços do PM2 ao ligar o PC e confere a cada 5 min (scripts\windows\vigia-pm2.ps1).' | Out-Null
} catch {
  Falhar "O Windows não aceitou criar a tarefa: $($_.Exception.Message) (senha errada?)"
}

Passo 'Pronto'
Write-Host "O BenURA agora sobe sozinho com o Windows (tarefa ""$NomeTarefa"")." -ForegroundColor Green
Write-Host '  Conferir:      npm run servico:verificar'
Write-Host '  Ver os logs:   npx pm2 logs   (e logs\servico-windows.log, do vigia)'
Write-Host '  Mudou a lista de serviços? Rode "npx pm2 save" para valer no próximo boot.'
Write-Host '  Desinstalar:   npm run servico:desinstalar   (como administrador)'
