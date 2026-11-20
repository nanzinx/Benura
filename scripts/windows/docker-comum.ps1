<#
.SYNOPSIS
  [NOVO] Funções comuns do BenURA no Docker do servidor (Windows 10 + WSL2 + Docker Engine).
  Carregado com ". $PSScriptRoot\docker-comum.ps1" pelos scripts docker-*.ps1.
#>

$Distro = 'Ubuntu'
$Portas = @(3000, 3001, 3010)   # rodízio (webhooks da Argus), roteador (webhook de venda), painel
$NomeTarefaServidor = 'BenURA Docker'
$NomeTarefaAtualizador = 'BenURA Docker atualizador'
$NomeTarefaPm2 = 'BenURA'        # a tarefa do PM2 como serviço do Windows (scripts\windows\instalar-servico.ps1)
$NomeRegraFirewall = 'BenURA Docker'

function Passo([string]$texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Falhar([string]$texto) { Write-Host "`nERRO: $texto" -ForegroundColor Red; exit 1 }

function Exigir-Administrador {
  $identidade = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identidade.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Falhar 'Abra o PowerShell como administrador (botão direito → "Executar como administrador") e rode de novo.'
  }
}

<# Roda um comando no Ubuntu do WSL como root. Devolve as linhas da saída; $LASTEXITCODE fica com o código. #>
function Wsl([string]$comando) {
  $saida = & wsl.exe -d $Distro -u root -- bash -lc $comando 2>&1
  return @($saida | ForEach-Object { "$_" })
}

<# O wsl.exe -l escreve em UTF-16: tira os zeros para comparar. #>
function Distros-Instaladas {
  $lista = & wsl.exe -l -q 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $lista) { return @() }
  return @($lista | ForEach-Object { ("$_" -replace "`0", '').Trim() } | Where-Object { $_ })
}

<# C:\BenURA → /mnt/c/BenURA #>
function Caminho-Wsl([string]$caminho) {
  $r = Wsl "wslpath -a '$($caminho -replace '\\', '/')'"
  if ($LASTEXITCODE -ne 0) { Falhar "Não consegui converter o caminho $caminho para o WSL: $($r -join ' ')" }
  return ($r | Select-Object -Last 1).Trim()
}

<# docker compose na pasta do BenURA. As portas abrem em 0.0.0.0 DENTRO do WSL (que fica atrás do
   NAT do Windows): de fora só chega pelo repasse do Windows (portproxy) no IP da rede da empresa. #>
function Compose([string]$pastaWsl, [string]$argumentos) {
  return Wsl "cd '$pastaWsl' && BENURA_IP_WEBHOOKS=0.0.0.0 BENURA_IP_PAINEL=0.0.0.0 docker compose $argumentos"
}

<# Espera o container ficar "healthy" (o /health do painel). #>
function Esperar-Saudavel([int]$segundos = 180) {
  $limite = (Get-Date).AddSeconds($segundos)
  while ((Get-Date) -lt $limite) {
    $estado = (Wsl "docker inspect -f '{{.State.Health.Status}}' benura 2>/dev/null" | Select-Object -Last 1)
    if ("$estado".Trim() -eq 'healthy') { return $true }
    Start-Sleep -Seconds 5
  }
  return $false
}

<# O IP deste PC na rede da empresa (a placa com gateway). #>
function Ip-Da-Rede {
  $config = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
  if (-not $config) { return $null }
  return ($config.IPv4Address | Select-Object -First 1).IPAddress
}

<# Repasse do Windows para o WSL (o IP do WSL muda a cada boot: refazer ao ligar). Só no IP da rede:
   o localhost do Windows já chega no WSL sozinho (é por ele que o túnel da Cloudflare vê o painel). #>
function Atualizar-Repasse {
  $ipWsl = ((Wsl "hostname -I") -join ' ').Trim().Split(' ')[0]
  $ipRede = Ip-Da-Rede
  if (-not $ipWsl -or -not $ipRede) { return "sem repasse (IP do WSL: '$ipWsl', IP da rede: '$ipRede')" }
  foreach ($porta in $Portas) {
    & netsh.exe interface portproxy delete v4tov4 listenport=$porta listenaddress=$ipRede 2>&1 | Out-Null
    & netsh.exe interface portproxy add v4tov4 listenport=$porta listenaddress=$ipRede connectport=$porta connectaddress=$ipWsl | Out-Null
  }
  return "repasse $ipRede → WSL $ipWsl nas portas $($Portas -join ', ')"
}

function Remover-Repasse {
  $ipRede = Ip-Da-Rede
  foreach ($porta in $Portas) {
    if ($ipRede) { & netsh.exe interface portproxy delete v4tov4 listenport=$porta listenaddress=$ipRede 2>&1 | Out-Null }
  }
}

<# Lê uma chave do .env (sem aspas). #>
function Ler-Env([string]$pasta, [string]$chave, [string]$padrao = '') {
  $arquivo = Join-Path $pasta '.env'
  if (-not (Test-Path $arquivo)) { return $padrao }
  $linha = Get-Content $arquivo | Where-Object { $_ -match "^\s*$chave\s*=" } | Select-Object -Last 1
  if (-not $linha) { return $padrao }
  $valor = ($linha -replace "^\s*$chave\s*=\s*", '').Trim().Trim('"').Trim("'")
  if ($valor) { return $valor } else { return $padrao }
}

<# Uma linha JSON no histórico de implantações (dados\logs\deploy-docker.jsonl). #>
function Anotar-Deploy([string]$pasta, [hashtable]$registro) {
  $logs = [IO.Path]::Combine($pasta, 'dados', 'logs')
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $registro['em'] = (Get-Date).ToUniversalTime().ToString('o')
  Add-Content -Path (Join-Path $logs 'deploy-docker.jsonl') -Value ($registro | ConvertTo-Json -Compress) -Encoding UTF8
}
