'use strict';
/**
 * Notificador padrão: registra cada aviso no log do processo e numa trilha
 * JSON Lines (logs/notificacoes.jsonl). Não envia nada para fora.
 *
 * Contrato de qualquer notificador:
 *   notificar({ titulo: string, texto: string, nivel?: 'info'|'aviso'|'erro', dados?: object }): Promise<{ ok, destino, erro? }>
 *
 * [NOVO] Para fora (o BenHub), veja notificador-webhook.js: mesmo método.
 */

class NotificadorLog {
  /**
   * @param {object} deps
   * @param {import('../repositories/auditoria.repository').AuditoriaRepository} deps.trilha
   * @param {object} deps.logger
   */
  constructor({ trilha, logger }) {
    this.trilha = trilha;
    this.log = logger;
  }

  descricao() {
    return { tipo: 'log', destino: 'log' };
  }

  async notificar({ titulo, texto, nivel = 'info', dados = {} }) {
    const registrar = { info: this.log.info, aviso: this.log.aviso, erro: this.log.erro }[nivel] || this.log.info;
    registrar(`[notificação] ${titulo} — ${texto}`);
    await this.trilha.registrar(`notificacao.${nivel}`, { titulo, texto, dados });
    return { ok: true, destino: 'log' };
  }
}

module.exports = { NotificadorLog };
