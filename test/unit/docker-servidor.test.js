'use strict';
/** [NOVO] Os scripts do BenURA no Docker do servidor (Windows 10 + WSL2): o que dá para conferir sem Windows. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel));
/** Texto com quebra de linha do Linux (no Windows, o git entrega CRLF). */
const texto = (rel) => ler(rel).toString().replace(/\r\n/g, '\n');

test('scripts do Windows: com BOM (o PowerShell 5.1 lê os acentos) e chamando o comum que existe', () => {
  for (const nome of ['docker-comum.ps1', 'docker-instalar.ps1', 'docker-servidor.ps1', 'docker-voltar-pm2.ps1']) {
    const bruto = ler(`scripts/windows/${nome}`);
    assert.deepEqual([...bruto.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${nome} sem BOM`);
    if (nome !== 'docker-comum.ps1') assert.match(bruto.toString(), /docker-comum\.ps1/, `${nome} não carrega o comum`);
  }
});

test('script do Ubuntu: LF puro (roda direto da pasta do Windows) e o .gitattributes garante isso', () => {
  const sh = ler('scripts/wsl/instalar-docker.sh').toString();
  assert.ok(sh.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(!sh.includes('\r'), 'CRLF quebra o bash');
  assert.match(sh, /set -euo pipefail/);
  assert.match(texto('.gitattributes'), /^\*\.sh text eol=lf$/m);
});

test('as portas repassadas pelo Windows são as que o compose publica', () => {
  const comum = texto('scripts/windows/docker-comum.ps1');
  const portas = /\$Portas = @\(([\d,\s]+)\)/.exec(comum)[1].split(',').map((p) => Number(p.trim()));
  const compose = texto('docker-compose.yml');
  const publicadas = [...compose.matchAll(/:(\d+):(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(portas.sort(), publicadas.sort());
});

test('.env.docker: opcional no compose, fora do git e fora da imagem', () => {
  assert.match(texto('docker-compose.yml'), /- path: \.env\.docker\n\s+required: false/);
  assert.match(texto('.gitignore'), /^\.env\.docker$/m);
  assert.match(texto('.dockerignore'), /^\.env\.\*$/m);
});
