'use strict';
/**
 * [NOVO] Avisos para fora (ex.: o BenHub): POST de { titulo, texto, nivel, origem, em } na
 * NOTIFICACOES_WEBHOOK_URL, com "Authorization: Bearer NOTIFICACOES_WEBHOOK_TOKEN".
 * Cada aviso também fica no log de hoje (o NotificadorLog), chegue ou não lá fora.
 * Os `dados` ficam só no log: para fora vai apenas o texto.
 */

const { requisitar: requisitarHttp, comRetry } = require('../utils/http-client');

class NotificadorWebhook {
  /**
   * @param {object} deps
   * @param {string} deps.url
   * @param {string} [deps.token]
   * @param {{ notificar(aviso: object): Promise<object> }} deps.registro - o log de hoje (NotificadorLog)
   * @param {number} [deps.timeoutMs]
   * @param {number} [deps.tentativas]
   */
  constructor({ url, token = '', registro, logger, timeoutMs = 5000, tentativas = 2, baseMs = 500, requisitar = requisitarHttp, agora = Date.now }) {
    Object.assign(this, { url, token, registro, log: logger, timeoutMs, tentativas, baseMs, requisitar, agora });
  }

  descricao() {
    return { tipo: 'webhook', destino: 'definido' };
  }

  /** @returns {Promise<{ ok: boolean, destino: 'webhook', erro?: string }>} nunca lança */
  async notificar({ titulo, texto, nivel = 'info', dados = {} }) {
    await this.registro.notificar({ titulo, texto, nivel, dados });
    const corpo = { titulo, texto, nivel, origem: 'BenURA', em: new Date(this.agora()).toISOString() };
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    try {
      await comRetry(() => this.requisitar(this.url, { metodo: 'POST', headers, corpo, timeoutMs: this.timeoutMs }), { tentativas: this.tentativas, baseMs: this.baseMs });
      return { ok: true, destino: 'webhook' };
    } catch (e) {
      // Sem o endereço no log (pode levar segredo no caminho): só o motivo.
      const erro = e.timeout || e.name === 'TimeoutError' ? 'não respondeu a tempo' : e.status ? `HTTP ${e.status}` : 'sem conexão';
      this.log.aviso(`Aviso "${titulo}" não chegou ao webhook (${erro}); ficou só no log.`);
      return { ok: false, destino: 'webhook', erro };
    }
  }
}

module.exports = { NotificadorWebhook };
