#!/usr/bin/env bash
# BenURA no Docker do servidor (Windows 10 + WSL2): instala o Docker Engine no Ubuntu do WSL.
# Roda como root dentro do Ubuntu; quem chama é o scripts\windows\docker-instalar.ps1.
# Pode rodar de novo (não duplica nada).
set -euo pipefail

if [ "$(id -u)" != 0 ]; then echo "ERRO: rode como root (wsl -d Ubuntu -u root)." >&2; exit 1; fi
if [ "$(ps -p 1 -o comm=)" != systemd ]; then
  echo "ERRO: o systemd não está ligado no WSL (/etc/wsl.conf [boot] systemd=true e 'wsl --update')." >&2
  exit 1
fi

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "Docker já instalado: $(docker --version)"
else
  echo "==> Instalando o Docker Engine (repositório oficial do Docker)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  codinome="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codinome} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Sobe junto com o Ubuntu do WSL; o container (restart: unless-stopped) sobe junto com o Docker.
systemctl enable --now docker containerd
# Logs do Docker com limite (o compose já limita os do BenURA; isto vale para o resto).
if [ ! -f /etc/docker/daemon.json ]; then
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "5" }\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi
docker version --format 'Docker {{.Server.Version}}'
docker compose version
