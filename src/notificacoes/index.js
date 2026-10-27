'use strict';
/**
 * Escolhe o notificador pela configuração (NOTIFICADOR).
 *   log     → NotificadorLog (padrão): log do processo + logs/notificacoes.jsonl
 *   webhook → [NOVO] NotificadorWebhook: o mesmo log + POST na NOTIFICACOES_WEBHOOK_URL (ex.: o BenHub)
 */

const fs = require('fs');
const path = require('path');
const { AuditoriaRepository } = require('../repositories/auditoria.repository');
const { NotificadorLog } = require('./notificador-log');
const { NotificadorWebhook } = require('./notificador-webhook');

function criarNotificador({ cfg, logger }) {
  const { tipo, arquivo, webhook = {} } = cfg.notificacoes;
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const log = logger.filho ? logger.filho('notificacoes') : logger;
  const registro = new NotificadorLog({ trilha: new AuditoriaRepository({ arquivo, logger }), logger: log });

  if (tipo === 'webhook' && webhook.url) {
    return new NotificadorWebhook({ url: webhook.url, token: webhook.token, timeoutMs: webhook.timeoutMs, registro, logger: log });
  }
  if (tipo === 'webhook') logger.aviso('NOTIFICADOR=webhook sem NOTIFICACOES_WEBHOOK_URL: os avisos ficam só no log.');
  else if (tipo !== 'log') logger.aviso(`NOTIFICADOR="${tipo}" não existe (use log ou webhook); usando log.`);
  return registro;
}

module.exports = { criarNotificador };
