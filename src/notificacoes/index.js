'use strict';
/**
 * Escolhe o notificador pela configuração (NOTIFICADOR).
 *   log    → NotificadorLog (padrão): log do processo + logs/notificacoes.jsonl
 *   benhub → também posta no grupo BENHUB_CHAT_ID do BenHub (o log continua)
 */

const fs = require('fs');
const path = require('path');
const { AuditoriaRepository } = require('../repositories/auditoria.repository');
const { NotificadorLog } = require('./notificador-log');
const { NotificadorBenHub } = require('./notificador-benhub');

/** O que falta para usar o BenHub. @returns {string|null} */
function faltaParaBenHub(b) {
  if (!b.chatId) return 'BENHUB_CHAT_ID';
  if (!(b.email && b.senha) && !b.token) return 'BENHUB_EMAIL e BENHUB_SENHA';
  return null;
}

function criarNotificador({ cfg, logger }) {
  const { tipo, arquivo, benhub } = cfg.notificacoes;
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const log = new NotificadorLog({ trilha: new AuditoriaRepository({ arquivo, logger }), logger: logger.filho('notificacoes') });
  if (tipo === 'log') return log;

  const falta = tipo === 'benhub' ? faltaParaBenHub(benhub) : `NOTIFICADOR="${tipo}" desconhecido`;
  if (falta) {
    logger.aviso(`Avisos só no log: falta ${falta}.`);
    return log;
  }
  return new NotificadorBenHub({ cfg: benhub, reserva: log, logger: logger.filho('benhub') });
}

module.exports = { criarNotificador, faltaParaBenHub };
