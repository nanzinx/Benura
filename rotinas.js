#!/usr/bin/env node
'use strict';
/**
 * ROTINAS DIÁRIAS — fim de expediente limpo (e, nas próximas rodadas, bases e planilha).
 *
 * PM2: app benura-rotinas em ecosystem.config.js. Lógica em src/rotinas/.
 *   npm run rotinas:agora               confere se está na hora e sai
 *   npm run rotinas:agora -- --forcar   executa já, ignorando o horário
 */

const { iniciarRotinas } = require('./src/rotinas/app');

iniciarRotinas().catch((e) => {
  console.error(new Date().toISOString(), '[ERRO] Falha fatal nas rotinas:', e);
  process.exit(1);
});
