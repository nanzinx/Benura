<#
.SYNOPSIS
  Mostra como está o BenURA neste PC: a tarefa do Windows, os serviços no PM2, se cada um
  responde no /health e, se houver, o túnel (cloudflared ou Tailscale). Não muda nada.
#>
[CmdletBinding()]
param([string]$Pasta = (Resolve-Path ([IO.Path]::Combine($PSScriptRoot, '..', '..'))).Path)

$ErrorActionPreference = 'Continue'
function Titulo([string]$texto) { Write-Host "`n== $texto" -ForegroundColor Cyan }
function Ok([string]$texto) { Write-Host "  [ok] $texto" -ForegroundColor Green }
function Ruim([string]$texto) { Write-Host "  [!!] $texto" -ForegroundColor Yellow }

Titulo 'Início automático (Agendador de Tarefas)'
$tarefa = Get-ScheduledTask -TaskName 'BenURA' -ErrorAction SilentlyContinue
if ($tarefa) {
  $info = Get-ScheduledTaskInfo -TaskName 'BenURA'
  Ok "tarefa ""BenURA"": $($tarefa.State), roda como $($tarefa.Principal.UserId)"
  Write-Host "  última vez: $($info.LastRunTime) (resultado $($info.LastTaskResult)); próxima: $($info.NextRunTime)"
} else {
  Ruim 'a tarefa "BenURA" não existe: o BenURA não sobe sozinho com o Windows (npm run servico:instalar, como administrador).'
}

Titulo 'Serviços no PM2'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$pm2 = [IO.Path]::Combine($Pasta, 'node_modules', 'pm2', 'bin', 'pm2')
if (-not $node -or -not (Test-Path $pm2)) {
  Ruim 'Node.js ou PM2 não encontrado (rode npm ci).'
} else {
  $estado = [IO.Path]::Combine($Pasta, 'scripts', 'windows', 'pm2-estado.js')
  $linhas = @(& $node $estado $Pasta 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { Ruim "o PM2 não respondeu: $($linhas -join ' ')" }
  elseif (-not $linhas.Count) { Ruim 'nenhum serviço do BenURA no PM2.' }
  else {
    foreach ($l in $linhas) {
      $nome, $status, $reinicios = $l -split "`t"
      $texto = "${nome}: $status (reinícios: $reinicios)"
      if ($status -eq 'online') { Ok $texto } else { Ruim $texto }
    }
  }
}

Titulo 'Respondendo no /health'
$portas = [ordered]@{ 'painel' = 3010; 'rodízio' = 3000; 'roteador' = 3001; 'rotinas' = 3003; 'atualizador' = 3002 }
foreach ($nome in $portas.Keys) {
  $url = "http://localhost:$($portas[$nome])/health"
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $url
    Ok "$nome ($url): HTTP $($r.StatusCode)"
  } catch {
    Ruim "$nome ($url): não respondeu"
  }
}

Titulo 'Túnel'
$cloudflared = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if ($cloudflared) {
  if ($cloudflared.Status -eq 'Running') { Ok 'cloudflared: rodando (serviço do Windows)' } else { Ruim "cloudflared: $($cloudflared.Status)" }
} else {
  Write-Host '  cloudflared: não instalado (o túnel definitivo é a parte 3 do README).'
}
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  $funnel = (& tailscale funnel status 2>&1 | Out-String).Trim()
  Write-Host "  Tailscale Funnel:`n$funnel"
}
