<#
.SYNOPSIS
  Vigia do BenURA (roda pela tarefa "BenURA" do Agendador): ao ligar o PC e a cada 5 min.
  Se o PM2 não está de pé ou perdeu a lista de serviços, restaura a lista salva (pm2 resurrect).
  Serviço parado de propósito (ex.: "Desligar automação" no painel) continua na lista, parado:
  o vigia não religa. Anota o que fez em logs\servico-windows.log.
#>
[CmdletBinding()]
param([string]$Pasta = (Resolve-Path ([IO.Path]::Combine($PSScriptRoot, '..', '..'))).Path)

# 'Continue': no PowerShell 5.1, saída de erro de programa redirecionada com 'Stop' vira exceção.
$ErrorActionPreference = 'Continue'
$logs = Join-Path $Pasta 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$registro = Join-Path $logs 'servico-windows.log'
function Anotar([string]$texto) { Add-Content -Path $registro -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $texto" -Encoding UTF8 }

try {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  $pm2 = [IO.Path]::Combine($Pasta, 'node_modules', 'pm2', 'bin', 'pm2')
  Set-Location $Pasta

  # O jlist sobe o PM2 se ele não estiver de pé (aí vem vazio): então é preciso restaurar.
  $estado = [IO.Path]::Combine($Pasta, 'scripts', 'windows', 'pm2-estado.js')
  $servicos = @(& $node $estado $Pasta 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { Anotar "PM2 não respondeu: $($servicos -join ' ')"; exit 1 }
  if ($servicos.Count -gt 0) { exit 0 }

  Anotar 'PM2 sem os serviços do BenURA: restaurando a lista salva (pm2 resurrect).'
  $resultado = & $node $pm2 resurrect 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Anotar "pm2 resurrect falhou: $($resultado.Trim())"; exit 1 }
  Anotar 'Serviços restaurados.'
} catch {
  Anotar "Vigia falhou: $($_.Exception.Message)"
  exit 1
}
