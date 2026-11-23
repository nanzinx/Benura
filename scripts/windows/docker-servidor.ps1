<#
.SYNOPSIS
  [NOVO] BenURA no Docker do servidor (Windows 10 + WSL2). Roda pelas tarefas do Agendador que o
  docker-instalar.ps1 cria; também dá para rodar à mão.

.PARAMETER Acao
  iniciar    ao ligar o PC (tarefa "BenURA Docker"): liga o Ubuntu do WSL, confere o container,
             refaz o repasse das portas e fica segurando o WSL ligado (sem isso ele desliga sozinho).
  atualizar  a cada minuto (tarefa "BenURA Docker atualizador"): fora do expediente, traz a main;
             se mudou, reconstrói e reinicia o container e volta ao commit anterior se não ficar saudável.
  status     mostra o container, os serviços no PM2 de dentro, o repasse e as últimas implantações.

.PARAMETER Agora
  Com "atualizar": implanta mesmo dentro do expediente (emergência).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\docker-servidor.ps1 -Acao status
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateSet('iniciar', 'atualizar', 'status')] [string]$Acao,
  [string]$Pasta = '',
  [switch]$Agora
)
# [NOVO] A pasta do BenURA, calculada aqui: no valor padrão do param(), o $PSScriptRoot pode vir vazio
# no PowerShell 5.1 (aí a pasta virava C:\ e o script não achava o .env).
if (-not $Pasta) { $Pasta = (Resolve-Path ([IO.Path]::Combine($PSScriptRoot, '..', '..'))).Path }

# 'Continue': no PowerShell 5.1, saída de erro de programa redirecionada com 'Stop' vira exceção.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'docker-comum.ps1')

$logs = [IO.Path]::Combine($Pasta, 'dados', 'logs')
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$registro = Join-Path $logs 'servidor-docker.log'
function Anotar([string]$texto) { Add-Content -Path $registro -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $texto" -Encoding UTF8 }

$pastaWsl = Caminho-Wsl $Pasta

if ($Acao -eq 'iniciar') {
  Wsl 'true' | Out-Null
  # O Docker sobe com o systemd do Ubuntu; o container, com o Docker (restart: unless-stopped).
  $limite = (Get-Date).AddMinutes(3)
  do { Wsl 'docker info >/dev/null 2>&1' | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 5 } while ((Get-Date) -lt $limite)
  if ($LASTEXITCODE -ne 0) { Anotar 'O Docker não respondeu em 3 min.' }
  # "up -d" sem --build: só garante que está de pé (não recria um container saudável).
  $r = Compose $pastaWsl 'up -d'
  if ($LASTEXITCODE -ne 0) { Anotar "docker compose up falhou: $($r -join ' ')" }
  Anotar (Atualizar-Repasse)
  # Segura o WSL ligado enquanto a tarefa roda (a tarefa não tem limite de tempo).
  & wsl.exe -d $Distro -u root -- sleep infinity
  Anotar 'O WSL foi encerrado (a tarefa tenta de novo em até 5 min).'
  exit 0
}

if ($Acao -eq 'status') {
  Write-Host '== Container' -ForegroundColor Cyan
  Compose $pastaWsl 'ps' | Write-Host
  Write-Host "`n== Serviços no PM2 (dentro do container)" -ForegroundColor Cyan
  Wsl 'docker exec benura npx pm2 list' | Write-Host
  Write-Host "`n== Versão" -ForegroundColor Cyan
  & git -C $Pasta log -1 --format='%h %s (%cr)' | Write-Host
  Write-Host "`n== Repasse das portas" -ForegroundColor Cyan
  & netsh.exe interface portproxy show v4tov4 | Write-Host
  Write-Host "`n== Últimas implantações" -ForegroundColor Cyan
  $deploys = [IO.Path]::Combine($logs, 'deploy-docker.jsonl')
  if (Test-Path $deploys) { Get-Content $deploys -Tail 5 | Write-Host } else { Write-Host '(nenhuma ainda)' }
  exit 0
}

# --- atualizar ---
$ramo = Ler-Env $Pasta 'ATUALIZADOR_BRANCH' 'main'
if (-not $Agora) {
  # A mesma janela do atualizador do PM2: nos dias úteis, só fora do expediente.
  $inicio = Ler-Env $Pasta 'HORARIO_CARGA' '08:00'
  $fim = Ler-Env $Pasta 'HORARIO_FIM' '18:00'
  $agoraHora = (Get-Date).ToString('HH:mm')
  $diaUtil = (Get-Date).DayOfWeek -notin @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)
  if ($diaUtil -and $agoraHora -ge $inicio -and $agoraHora -lt $fim) { exit 0 }
}

& git -C $Pasta fetch --quiet origin $ramo 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Anotar 'git fetch falhou (sem rede ou sem acesso ao GitHub).'; exit 1 }
$atual = (& git -C $Pasta rev-parse HEAD).Trim()
$novo = (& git -C $Pasta rev-parse "origin/$ramo").Trim()
if ($atual -eq $novo) { exit 0 }

if (& git -C $Pasta status --porcelain --untracked-files=no) {
  Anotar-Deploy $Pasta @{ resultado = 'ABORTADO'; motivo = 'alteração local em arquivo versionado'; de = $atual; para = $novo }
  exit 1
}
& git -C $Pasta merge-base --is-ancestor $atual $novo
if ($LASTEXITCODE -ne 0) {
  Anotar-Deploy $Pasta @{ resultado = 'ABORTADO'; motivo = "a pasta divergiu de origin/$ramo"; de = $atual; para = $novo }
  exit 1
}

& git -C $Pasta merge --ff-only --quiet "origin/$ramo" 2>&1 | Out-Null
$r = Compose $pastaWsl 'up -d --build'
if ($LASTEXITCODE -eq 0 -and (Esperar-Saudavel 180)) {
  Anotar-Deploy $Pasta @{ resultado = 'IMPLANTADO'; de = $atual; para = $novo }
  exit 0
}

# Não ficou saudável: volta ao commit anterior e reconstrói.
$erro = ($r | Select-Object -Last 5) -join ' '
& git -C $Pasta reset --hard --quiet $atual
Compose $pastaWsl 'up -d --build' | Out-Null
$voltou = Esperar-Saudavel 180
Anotar-Deploy $Pasta @{ resultado = 'REVERTIDO'; de = $atual; para = $novo; erro = $erro; saudavelDepois = $voltou }
exit 1
