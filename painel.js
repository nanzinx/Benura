#!/usr/bin/env node
'use strict';
/**
 * PAINEL DA SUPERVISÃO — controles da URA, esteira manual, saúde dos serviços e o dia.
 *
 * PM2: app benura-painel em ecosystem.config.js. Lógica em src/painel/.
 * Entrar exige um usuário (npm run usuarios -- criar) ou, sem nenhum, a PAINEL_SENHA do .env. Abra http://localhost:3010 (ou PAINEL_PORT).
 */

const { iniciarPainel } = require('./src/painel/app');

iniciarPainel().catch((e) => {
  console.error(new Date().toISOString(), '[ERRO] Falha fatal no painel:', e);
  process.exit(1);
});
