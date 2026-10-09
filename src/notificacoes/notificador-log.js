'use strict';
/**
 * Notificador padrão: registra cada aviso no log do processo e numa trilha
 * JSON Lines (logs/notificacoes.jsonl). Não envia nada para fora.
 *
 * Contrato de qualquer notificador:
 *   notificar({ titulo: string, texto: string, nivel?: 'info'|'aviso'|'erro', dados?: object }): Promise<void>
 *
 * Um canal de chat (ex.: o BenHub), quando for definido, entra como
 * outro adaptador com o mesmo método — os serviços não mudam.
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

  async notificar({ titulo, texto, nivel = 'info', dados = {} }) {
    const registrar = { info: this.log.info, aviso: this.log.aviso, erro: this.log.erro }[nivel] || this.log.info;
    registrar(`[notificação] ${titulo} — ${texto}`);
    await this.trilha.registrar(`notificacao.${nivel}`, { titulo, texto, dados });
  }
}

module.exports = { NotificadorLog };
