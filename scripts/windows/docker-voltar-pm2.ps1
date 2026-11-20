<#
.SYNOPSIS
  [NOVO] Volta o BenURA deste servidor do Docker para o PM2 (o caminho de antes da migração).

.DESCRIPTION
  1. Desliga as tarefas "BenURA Docker" e "BenURA Docker atualizador" e para o container.
  2. Copia o estado de dados\ de volta para onde o PM2 lê (o dia continua de onde parou).
  3. Tira o repasse das portas (o PM2 escuta direto no Windows).
  4. Religa a tarefa "BenURA" e restaura os serviços do PM2 (pm2 resurrect).
  O Docker e o Ubuntu continuam instalados: para voltar ao Docker, rode o docker-instalar.ps1 de novo.

.PARAMETER SemCopiarEstado
  Não copia o estado de volta (o docker-instalar.ps1 usa quando o container nem chegou a subir).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\docker-voltar-pm2.ps1
#>
[CmdletBinding()]
param(
  [string]$Pasta = (Resolve-Path ([IO.Path]::Combine($PSScriptRoot, '..', '..'))).Path,
  [switch]$SemCopiarEstado
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'docker-comum.ps1')
Exigir-Administrador

Passo 'Parando o BenURA no Docker'
foreach ($tarefa in @($NomeTarefaServidor, $NomeTarefaAtualizador)) {
  if (Get-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $tarefa | Out-Null
    Write-Host "Tarefa ""$tarefa"" desligada."
  }
}
if ((Distros-Instaladas) -contains $Distro) {
  $pastaWsl = Caminho-Wsl $Pasta
  Compose $pastaWsl 'down' | Write-Host
}

if (-not $SemCopiarEstado) {
  Passo 'Copiando o estado de dados\ de volta para o PM2'
  $destino = Ler-Env $Pasta 'DADOS_DIR' $Pasta
  if (-not [IO.Path]::IsPathRooted($destino)) { $destino = Join-Path $Pasta $destino }
  $dados = Join-Path $Pasta 'dados'
  $copiados = 0
  foreach ($padrao in @('state*.json', '*.key', 'argus-pausa.json')) {
    foreach ($f in Get-ChildItem -Path $dados -Filter $padrao -File -ErrorAction SilentlyContinue) {
      Copy-Item $f.FullName -Destination $destino -Force
      $copiados++
    }
  }
  Write-Host "$copiados arquivo(s) copiado(s) para $destino."
}

Passo 'Tirando o repasse das portas'
Remover-Repasse

Passo 'Religando o PM2'
# No Docker, o atualizador pode ter trazido dependências novas: o PM2 roda com o node_modules do Windows.
if (Get-Command npm -ErrorAction SilentlyContinue) {
  Push-Location $Pasta
  try { & npm ci --no-audit --no-fund 2>&1 | Select-Object -Last 3 | Write-Host } finally { Pop-Location }
}
if (Get-ScheduledTask -TaskName $NomeTarefaPm2 -ErrorAction SilentlyContinue) {
  Enable-ScheduledTask -TaskName $NomeTarefaPm2 | Out-Null
  # A tarefa roda o vigia, que restaura a lista salva do PM2 (pm2 resurrect).
  Start-ScheduledTask -TaskName $NomeTarefaPm2
  Write-Host "Tarefa ""$NomeTarefaPm2"" religada: o PM2 restaura os serviços em alguns segundos." -ForegroundColor Green
} else {
  Write-Host "A tarefa ""$NomeTarefaPm2"" não existe: rode scripts\windows\instalar-servico.ps1 -ComAtualizador." -ForegroundColor Yellow
}
Write-Host 'Conferir: npx pm2 list   (e npm run servico:verificar)'
