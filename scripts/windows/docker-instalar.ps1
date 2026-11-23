<#
.SYNOPSIS
  [NOVO] Passa o BenURA deste servidor (Windows 10) do PM2 para o Docker, num Linux (Ubuntu no WSL2).

.DESCRIPTION
  Rode como administrador, na pasta do BenURA. Pode rodar de novo: cada passo confere se já foi feito.
   1. Confere o Windows (10 versão 21H2 ou mais nova) e instala o WSL2 com o Ubuntu.
      Na primeira vez o Windows pede para reiniciar: reinicie e rode o script de novo.
   2. Liga o systemd no Ubuntu e deixa a pasta do Windows gravável pelo container (uid 1000).
   3. Instala o Docker Engine no Ubuntu (scripts/wsl/instalar-docker.sh).
   4. Para o BenURA do PM2 (para a tarefa "BenURA" e o PM2, sem desinstalar: dá para voltar).
   5. Copia o estado (state*.json, chaves, JSON de ramais e supervisores) para a pasta dados\
      e cria o .env.docker, que aponta os caminhos do .env para dentro do container.
   6. Constrói e sobe o container. Se não ficar saudável em 3 min, volta para o PM2 sozinho.
   7. Libera as portas 3000, 3001 e 3010 no firewall (só rede da empresa) e cria as tarefas:
      "BenURA Docker" (ao ligar o PC, sem ninguém logado) e "BenURA Docker atualizador" (a cada minuto).

  Para voltar ao PM2: scripts\windows\docker-voltar-pm2.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\docker-instalar.ps1
#>
[CmdletBinding()]
param([string]$Pasta = '')
# [NOVO] A pasta do BenURA, calculada aqui: no valor padrão do param(), o $PSScriptRoot pode vir vazio
# no PowerShell 5.1 (aí a pasta virava C:\ e o script não achava o .env).
if (-not $Pasta) { $Pasta = (Resolve-Path ([IO.Path]::Combine($PSScriptRoot, '..', '..'))).Path }

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'docker-comum.ps1')
Exigir-Administrador
Set-Location $Pasta

# --- 1. Windows e WSL2 ---
Passo 'Conferindo o Windows'
$versao = [Environment]::OSVersion.Version
# 19044 = Windows 10 21H2: WSL2 com systemd (pelo "wsl --update").
if ($versao.Build -lt 19044) { Falhar "Windows $($versao.ToString()) é antigo: atualize para o Windows 10 21H2 ou mais novo (Windows Update) e rode de novo." }
if (-not (Test-Path (Join-Path $Pasta '.env'))) { Falhar "Não achei o .env em $Pasta (é o mesmo do PM2)." }
if (-not (Test-Path (Join-Path $Pasta 'docker-compose.yml'))) { Falhar "Não achei o docker-compose.yml em ${Pasta}: rode o script dentro da pasta do BenURA." }
Write-Host "Windows $($versao.ToString()) · pasta do BenURA: $Pasta"

if ((Distros-Instaladas) -notcontains $Distro) {
  Passo 'Instalando o WSL2 e o Ubuntu'
  & wsl.exe --install -d $Distro --no-launch
  # O WSL que vem no Windows 10 pode não conhecer o --no-launch.
  if ($LASTEXITCODE -ne 0) { & wsl.exe --install -d $Distro }
  if ($LASTEXITCODE -ne 0) { Falhar 'O "wsl --install" falhou (veja acima). Confira se a virtualização está ligada na BIOS.' }
  if ((Distros-Instaladas) -notcontains $Distro) {
    # Recurso do Windows recém-ligado: precisa reiniciar antes de usar.
    Write-Host "`nO WSL foi ativado. REINICIE o servidor e rode este script de novo." -ForegroundColor Yellow
    exit 0
  }
}
& wsl.exe --update 2>&1 | Out-Null
& wsl.exe --set-version $Distro 2 2>&1 | Out-Null

# Primeira vez: o Ubuntu ainda não foi inicializado (sem usuário). Inicializa com o root.
Wsl 'true' | Out-Null
if ($LASTEXITCODE -ne 0) {
  & ubuntu.exe install --root
  Wsl 'true' | Out-Null
  if ($LASTEXITCODE -ne 0) { Falhar 'Não consegui iniciar o Ubuntu do WSL. Abra "Ubuntu" no menu Iniciar uma vez e rode de novo.' }
}

# --- 2. systemd e a pasta do Windows gravável pelo container ---
Passo 'Configurando o Ubuntu (systemd e permissões da pasta do Windows)'
# Escrito no Windows (com quebra de linha do Linux) e copiado: sem aspas passando pelo wsl.exe.
$wslConf = @('[boot]', 'systemd=true', '', '[automount]', 'options = "metadata,uid=1000,gid=1000,umask=022"', '', '[user]', 'default=root', '') -join "`n"
$temp = Join-Path $env:TEMP 'benura-wsl.conf'
[IO.File]::WriteAllText($temp, $wslConf)
Wsl "cp '$(Caminho-Wsl $temp)' /etc/wsl.conf" | Out-Null
if ($LASTEXITCODE -ne 0) { Falhar 'Não consegui gravar o /etc/wsl.conf no Ubuntu.' }
& wsl.exe --terminate $Distro | Out-Null
Start-Sleep -Seconds 3
$init = (Wsl 'ps -p 1 -o comm=' | Select-Object -Last 1)
if ("$init".Trim() -ne 'systemd') { Falhar 'O systemd não ligou no Ubuntu. Rode "wsl --update", depois "wsl --shutdown", e este script de novo.' }

# --- 3. Docker Engine ---
Passo 'Instalando o Docker no Ubuntu'
$pastaWsl = Caminho-Wsl $Pasta
Wsl "bash '$pastaWsl/scripts/wsl/instalar-docker.sh'" | Write-Host
if ($LASTEXITCODE -ne 0) { Falhar 'A instalação do Docker falhou (veja acima).' }

# --- 4. Confirmação e parada do PM2 ---
Passo 'Parando o BenURA do PM2'
Write-Host 'A automação fica fora do ar por alguns minutos (até o container subir).' -ForegroundColor Yellow
Write-Host 'Faça isto fora do expediente. Para continuar, digite MIGRAR:' -NoNewline
if ((Read-Host ' ') -ne 'MIGRAR') { Write-Host 'Cancelado: nada foi parado.'; exit 0 }
if (Get-ScheduledTask -TaskName $NomeTarefaPm2 -ErrorAction SilentlyContinue) {
  Disable-ScheduledTask -TaskName $NomeTarefaPm2 | Out-Null
  Write-Host "Tarefa ""$NomeTarefaPm2"" desligada (continua instalada)."
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$pm2 = [IO.Path]::Combine($Pasta, 'node_modules', 'pm2', 'bin', 'pm2')
if ($node -and (Test-Path $pm2)) {
  & $node $pm2 save --force 2>&1 | Out-Null   # a lista de hoje fica salva para a volta
  & $node $pm2 kill 2>&1 | Out-Null
  Write-Host 'PM2 parado (a lista de serviços ficou salva).'
}

# --- 5. Estado para dados\ e o .env.docker ---
Passo 'Copiando o estado para a pasta dados\'
$dados = Join-Path $Pasta 'dados'
New-Item -ItemType Directory -Force -Path (Join-Path $dados 'logs') | Out-Null
# No PM2, o estado fica no DADOS_DIR do .env (ou na pasta do BenURA).
$origem = Ler-Env $Pasta 'DADOS_DIR' $Pasta
if (-not [IO.Path]::IsPathRooted($origem)) { $origem = Join-Path $Pasta $origem }
$copiados = 0
foreach ($padrao in @('state*.json', '*.key', 'supervisores-grupos.json', 'vendedores-ramais.json', 'argus-pausa.json', 'auditoria*.jsonl')) {
  foreach ($f in Get-ChildItem -Path $origem -Filter $padrao -File -ErrorAction SilentlyContinue) {
    Copy-Item $f.FullName -Destination $dados -Force
    $copiados++
  }
}
Write-Host "$copiados arquivo(s) copiado(s) de $origem."

# O container lê o mesmo .env; o .env.docker (lido depois) troca os caminhos de arquivo e pasta do
# Windows pelos do container: arquivos em /dados, travas em /run/benura.
$linhas = @('# Gerado pelo scripts\windows\docker-instalar.ps1: os caminhos do .env, dentro do container.')
foreach ($l in Get-Content (Join-Path $Pasta '.env')) {
  if ($l -match '^\s*([A-Z0-9_]+_(FILE|DIR))\s*=\s*(.+?)\s*$') {
    $chave = $Matches[1]
    $valor = $Matches[3].Trim('"').Trim("'")
    $nome = Split-Path ($valor -replace '\\', '/') -Leaf
    if ($chave -eq 'DADOS_DIR') { $linhas += 'DADOS_DIR=/dados'; continue }
    if ($chave -eq 'LOGS_DIR') { $linhas += 'LOGS_DIR=/dados/logs'; continue }
    if ($chave -like '*_LOCK_FILE') { $linhas += "$chave=/run/benura/$nome"; continue }
    $linhas += "$chave=/dados/$nome"
    $arquivo = if ([IO.Path]::IsPathRooted($valor)) { $valor } else { Join-Path $Pasta $valor }
    if (Test-Path $arquivo -PathType Leaf) { Copy-Item $arquivo -Destination $dados -Force }
  }
}
Set-Content -Path (Join-Path $Pasta '.env.docker') -Value $linhas -Encoding UTF8
Write-Host ".env.docker criado ($($linhas.Count - 1) caminho(s) trocado(s))."

# --- 6. Sobe o container ---
Passo 'Construindo e subindo o container (alguns minutos na primeira vez)'
Compose $pastaWsl 'up -d --build' | Write-Host
if ($LASTEXITCODE -ne 0 -or -not (Esperar-Saudavel 180)) {
  Write-Host "`nO container não ficou saudável. Últimas linhas do log:" -ForegroundColor Red
  Wsl 'docker logs --tail 40 benura' | Write-Host
  Write-Host "`nVoltando para o PM2..." -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot 'docker-voltar-pm2.ps1') -Pasta $Pasta -SemCopiarEstado
  Falhar 'A migração não foi concluída: o BenURA voltou para o PM2. Mande o log acima para análise.'
}
Write-Host 'Container saudável.' -ForegroundColor Green
# [NOVO] O commit que está no container: o atualizador compara com ele (docker-servidor.ps1 -Acao atualizar).
Set-Content -Path (Join-Path $dados 'deploy-docker-commit.txt') -Value ((& git -C $Pasta rev-parse HEAD).Trim()) -Encoding ASCII

# --- 7. Firewall, repasse e tarefas ---
Passo 'Liberando as portas na rede da empresa'
if (-not (Get-NetFirewallRule -DisplayName $NomeRegraFirewall -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $NomeRegraFirewall -Direction Inbound -Protocol TCP -LocalPort $Portas `
    -Action Allow -Profile Domain, Private -RemoteAddress LocalSubnet | Out-Null
}
Write-Host (Atualizar-Repasse)

Passo 'Criando as tarefas no Agendador'
$usuario = "$env:USERDOMAIN\$env:USERNAME"
$credencial = Get-Credential -UserName $usuario -Message 'Senha deste usuário do Windows: o BenURA no Docker sobe com ele mesmo sem ninguém logado'
if (-not $credencial) { Falhar 'Sem a senha não dá para criar as tarefas (o container segue no ar até reiniciar o PC).' }
$senha = $credencial.GetNetworkCredential().Password
$script = Join-Path $PSScriptRoot 'docker-servidor.ps1'
$argumentos = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Pasta `"$Pasta`" -Acao"

# Ao ligar o PC, e a cada 5 min (se o WSL cair, sobe de novo; com a tarefa rodando, a repetição é ignorada).
$aoLigar = New-ScheduledTaskTrigger -AtStartup
$aoLigar.Delay = 'PT1M'
$repetir = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
$semLimite = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $NomeTarefaServidor -Trigger @($aoLigar, $repetir) -Settings $semLimite `
  -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Pasta -Argument "$argumentos iniciar") `
  -User $usuario -Password $senha -RunLevel Highest -Force `
  -Description 'BenURA no Docker: liga o Ubuntu do WSL, confere o container, refaz o repasse das portas e mantém o WSL ligado.' | Out-Null

$cadaMinuto = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$curto = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $NomeTarefaAtualizador -Trigger $cadaMinuto -Settings $curto `
  -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Pasta -Argument "$argumentos atualizar") `
  -User $usuario -Password $senha -RunLevel Highest -Force `
  -Description 'BenURA no Docker: traz a main fora do expediente e reconstrói o container (volta se não ficar saudável).' | Out-Null
Start-ScheduledTask -TaskName $NomeTarefaServidor

Passo 'Pronto'
Write-Host 'O BenURA está no Docker e sobe sozinho com o Windows.' -ForegroundColor Green
Write-Host '  Conferir:        powershell -ExecutionPolicy Bypass -File scripts\windows\docker-servidor.ps1 -Acao status'
Write-Host '  Logs:            wsl -d Ubuntu -u root -- docker logs -f benura   (e dados\logs\)'
Write-Host '  Voltar ao PM2:   powershell -ExecutionPolicy Bypass -File scripts\windows\docker-voltar-pm2.ps1'
