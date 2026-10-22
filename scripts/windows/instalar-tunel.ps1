<#
.SYNOPSIS
  Instala o túnel da Cloudflare (cloudflared) como serviço do Windows, com o token do
  túnel "benura" criado no painel da Cloudflare. Liga https://benura-api.benconsig.com.br
  ao painel deste servidor (http://localhost:3010) sem abrir porta no roteador.

.DESCRIPTION
  1. Instala o cloudflared (winget), se ainda não houver.
  2. Pede o token do túnel sem mostrar na tela (ou recebe em -Token) e instala o serviço
     "cloudflared" (sobe sozinho com o Windows). Se já houver um, troca pelo novo.
  3. Confere se o serviço está rodando e se o painel responde no localhost:3010.
  O token não é gravado em lugar nenhum pelo script (o serviço do cloudflared guarda).

.PARAMETER Token
  O token do túnel (Zero Trust → Networks → Tunnels → benura → Install connector: o texto
  longo depois de "service install"). Sem ele, o script pergunta.

.EXAMPLE
  # No PowerShell como administrador, na pasta do BenURA:
  npm run tunel:instalar
#>
[CmdletBinding()]
param([string]$Token)

$ErrorActionPreference = 'Stop'
function Passo([string]$texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Falhar([string]$texto) { Write-Host "`nERRO: $texto" -ForegroundColor Red; exit 1 }

Passo 'Conferindo o PC'
$identidade = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identidade.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Falhar 'Abra o PowerShell como administrador (botão direito → "Executar como administrador") e rode de novo.'
}

Passo 'cloudflared'
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Falhar 'winget não encontrado. Baixe o cloudflared em https://github.com/cloudflare/cloudflared/releases (cloudflared-windows-amd64.msi), instale e rode de novo.'
  }
  Write-Host 'Instalando o cloudflared (winget)...'
  winget install --id Cloudflare.cloudflared --exact --accept-source-agreements --accept-package-agreements --silent
  # O winget não atualiza o PATH desta janela: procura onde ele instala.
  $candidatos = @(
    (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
    (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
  )
  $cloudflared = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $cloudflared) { Falhar 'O cloudflared foi instalado, mas não achei o executável. Feche e abra o PowerShell (como administrador) e rode de novo.' }
}
Write-Host "cloudflared: $cloudflared ($((& $cloudflared --version 2>&1 | Out-String).Trim()))"

Passo 'Token do túnel'
if (-not $Token) {
  Write-Host 'Cole o token do túnel "benura" (Zero Trust → Networks → Tunnels → benura → Install connector:'
  Write-Host 'é o texto longo que vem depois de "cloudflared.exe service install"). Ele não aparece na tela.'
  $seguro = Read-Host -AsSecureString 'Token'
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro))
}
$Token = $Token.Trim()
# Quem copiar o comando inteiro ("cloudflared.exe service install eyJ..."): fica só o token.
if ($Token -match '\s') { $Token = ($Token -split '\s+')[-1] }
if ($Token.Length -lt 50) { Falhar 'Esse token parece curto demais. Copie o texto longo que o painel da Cloudflare mostra (começa com "eyJ").' }

Passo 'Serviço do Windows "cloudflared"'
if (Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue) {
  Write-Host 'Já existe um serviço cloudflared: trocando pelo novo token.'
  & $cloudflared service uninstall 2>&1 | Out-Host
  Start-Sleep -Seconds 2
}
& $cloudflared service install $Token 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Falhar 'O cloudflared não conseguiu instalar o serviço (veja acima).' }
$Token = $null

$servico = $null
for ($i = 0; $i -lt 15; $i++) {
  $servico = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($servico -and $servico.Status -eq 'Running') { break }
  Start-Sleep -Seconds 1
}
if (-not $servico -or $servico.Status -ne 'Running') { Falhar 'O serviço cloudflared não ficou rodando. Veja em services.msc ou no Visualizador de Eventos.' }
Write-Host 'Serviço cloudflared rodando (sobe sozinho com o Windows).' -ForegroundColor Green

Passo 'Painel neste servidor'
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://localhost:3010/health'
  Write-Host "Painel respondendo (HTTP $($r.StatusCode)): o túnel vai levar até ele." -ForegroundColor Green
} catch {
  Write-Warning 'O painel não respondeu em http://localhost:3010. Suba o BenURA (npm run servico:instalar) antes de testar o túnel.'
}

Passo 'Pronto'
Write-Host 'No painel da Cloudflare (Zero Trust → Networks → Tunnels), o túnel "benura" deve ficar HEALTHY em até 1 min.'
Write-Host 'Falta (README, parte 3): Public Hostname benura-api.benconsig.com.br → http://localhost:3010, o Access e o Pages.'
Write-Host 'Conferir depois: npm run servico:verificar'
