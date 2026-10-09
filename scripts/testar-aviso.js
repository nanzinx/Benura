#!/usr/bin/env node
'use strict';
/**
 * Manda um aviso de teste pelo notificador configurado (NOTIFICADOR, BENHUB_*).
 *   npm run aviso:teste
 *   npm run aviso:teste -- "texto que quiser"
 */

const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { criarNotificador } = require('../src/notificacoes');

async function main() {
  const cfg = carregarConfig();
  const log = criarLogger({ debug: cfg.debug, escopo: 'aviso' });
  const notificador = criarNotificador({ cfg, logger: log });
  const texto = process.argv.slice(2).join(' ') || 'Teste de aviso do BenURA. Se apareceu aqui, está funcionando.';
  await notificador.notificar({ titulo: 'Teste', texto });
  log.info(`Enviado por: ${notificador.constructor.name === 'NotificadorBenHub' ? `BenHub (grupo ${cfg.notificacoes.benhub.chatId}) + log` : 'log'}.`);
}

main().catch((e) => {
  console.error('Falha no teste de aviso:', e.message);
  process.exit(1);
});
