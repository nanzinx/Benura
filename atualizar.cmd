@echo off
rem [NOVO] Atualiza o BenURA no Docker: traz a versao nova (main) e reconstroi o container.
rem Dois cliques, ou "atualizar" no PowerShell/Prompt dentro da pasta do BenURA. Pede administrador sozinho.
rem No expediente o BenURA fica de 1 a 3 min fora do ar. Se a versao nova nao subir, volta para a anterior.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\docker-servidor.ps1" -Acao atualizar -Agora
echo.
pause
