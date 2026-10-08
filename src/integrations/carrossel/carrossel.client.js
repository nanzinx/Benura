'use strict';
/**
 * Cliente HTTP da API do Carrossel (repositório Carrosel-BenApi).
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
    const { token, headerAuth, esquemaAuth } = this.cfg;
    if (!token) return {};
    return { [headerAuth]: esquemaAuth ? `${esquemaAuth} ${token}` : token };
  }

  /**
   * Busca as vendas consolidadas de todos os vendedores em uma data.
   *
   *   GET {baseUrl}{rotaVendedores}?{parametroData}=YYYY-MM-DD
   *
   * @param {string} data - YYYY-MM-DD
   * @returns {Promise<*>} Payload cru da API
   * @throws {HttpError}
   */
  async buscarVendasPorData(data) {
    const url = new URL(`${this.cfg.baseUrl}${this.cfg.rotaVendedores}`);
    url.searchParams.set(this.cfg.parametroData, data);

    return comRetry(
      () => requisitar(url.toString(), { headers: this.headers(), timeoutMs: this.cfg.timeoutMs }),
      {
        tentativas: this.cfg.tentativas,
        aoFalhar: (e, n) => this.log.aviso(`Tentativa ${n} falhou (${e.message}). Tentando novamente...`),
      },
    );
  }
}

module.exports = { CarrosselClient };
