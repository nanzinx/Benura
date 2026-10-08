'use strict';
/**
 * Escolhe o notificador pela configuração (NOTIFICADOR).
 *   log    → NotificadorLog (padrão)
 *   benhub → reservado: adaptador do chat interno, quando a integração for definida
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
