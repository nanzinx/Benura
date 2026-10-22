<#
.SYNOPSIS
  Tira o BenURA do início automático do Windows (remove a tarefa "BenURA").
  Os serviços que estão rodando agora continuam; para parar também, use -PararServicos.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\desinstalar-servico.ps1 -PararServicos
#>
[CmdletBinding()]
param(
  [string]$Pasta = (Resolve-Path ([IO.Path]::Combine($PSScriptRoot, '..', '..'))).Path,
  [switch]$PararServicos
)

$ErrorActionPreference = 'Stop'
$identidade = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identidade.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'ERRO: abra o PowerShell como administrador e rode de novo.' -ForegroundColor Red
  exit 1
}

if (Get-ScheduledTask -TaskName 'BenURA' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'BenURA' -Confirm:$false
  Write-Host 'Tarefa "BenURA" removida: o BenURA não sobe mais sozinho com o Windows.' -ForegroundColor Green
} else {
  Write-Host 'A tarefa "BenURA" não existe (nada a remover).'
}

if ($PararServicos) {
  $node = (Get-Command node).Source
  $pm2 = [IO.Path]::Combine($Pasta, 'node_modules', 'pm2', 'bin', 'pm2')
  Push-Location $Pasta
  try {
    & $node $pm2 delete all
    & $node $pm2 save --force
  } finally {
    Pop-Location
  }
  Write-Host 'Serviços parados e lista do PM2 esvaziada.' -ForegroundColor Green
}
