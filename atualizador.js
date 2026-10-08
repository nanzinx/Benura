#!/usr/bin/env node
'use strict';
/**
 * ATUALIZADOR DA PRODUÇÃO — traz a main para esta máquina e reinicia os serviços.
 *
 * Fica desligado até existir produção. Para ligar: npm run atualizador:iniciar
 * Veja "Esteira automática" no README. Lógica em src/atualizador/.
 */

const { iniciarAtualizador } = require('./src/atualizador/app');

iniciarAtualizador().catch((e) => {
  console.error(new Date().toISOString(), '[ERRO] Falha fatal no atualizador:', e);
  process.exit(1);
});
