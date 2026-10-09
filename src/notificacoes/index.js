'use strict';
/**
 * Escolhe o notificador pela configuração (NOTIFICADOR).
 *   log → NotificadorLog (padrão): log do processo + logs/notificacoes.jsonl
 * Outro canal (ex.: o chat interno) entra como outro adaptador com o mesmo método.
 */

const fs = require('fs');
const path = require('path');
const { AuditoriaRepository } = require('../repositories/auditoria.repository');
const { NotificadorLog } = require('./notificador-log');

function criarNotificador({ cfg, logger }) {
  const { tipo, arquivo } = cfg.notificacoes;
  if (tipo !== 'log') logger.aviso(`NOTIFICADOR="${tipo}" ainda não tem integração; usando log.`);

  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  return new NotificadorLog({ trilha: new AuditoriaRepository({ arquivo, logger }), logger: logger.filho('notificacoes') });
}

module.exports = { criarNotificador };
