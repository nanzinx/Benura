'use strict';
/**
 * Cliente HTTP da API do Carrossel (Carrosel-BenApi).
 *
 * Responsabilidade única: falar HTTP com a API e devolver o payload cru.
 * Normalização fica no mapper; regras de negócio ficam nos serviços.
 */

const { requisitar, comRetry } = require('../../utils/http-client');

class CarrosselClient {
  /**
   * @param {object} cfg - Seção `carrossel` da configuração
   * @param {object} logger
   */
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
  }

  headers() {
    // ngrok-free exibe uma página de aviso para clientes sem este header.
    const headers = { 'ngrok-skip-browser-warning': '1' };
    const { token, headerAuth, esquemaAuth } = this.cfg;
    if (token) headers[headerAuth] = esquemaAuth ? `${esquemaAuth} ${token}` : token;
    return headers;
  }

  /**
   * Busca o ranking consolidado de vendedores (todos os períodos).
   *
   *   GET {baseUrl}{rotaRanking}   (padrão: /ranking/vendedores)
   *
   * @returns {Promise<*>} Payload cru da API
   * @throws {HttpError}
   */
  async buscarRankingVendedores() {
    const url = `${this.cfg.baseUrl}${this.cfg.rotaRanking}`;
    return comRetry(
      () => requisitar(url, { headers: this.headers(), timeoutMs: this.cfg.timeoutMs }),
      {
        tentativas: this.cfg.tentativas,
        aoFalhar: (e, n) => this.log.aviso(`Tentativa ${n} falhou (${e.message}). Tentando novamente...`),
      },
    );
  }
}

module.exports = { CarrosselClient };
