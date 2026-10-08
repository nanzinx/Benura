'use strict';
/**
 * Serviço de integração com o Carrossel.
 *
 * Expõe operações em linguagem de negócio ("vendas de ontem", "vendas de hoje")
 * e garante resiliência:
 *  - erros de rede/HTTP são convertidos em `CarrosselIndisponivelError`;
 *  - mantém o último resultado válido de cada data como fallback.
 */

const { mapearResposta } = require('./carrossel.mapper');

class CarrosselIndisponivelError extends Error {
  constructor(mensagem, cause) {
    super(mensagem, { cause });
    this.name = 'CarrosselIndisponivelError';
  }
}

class CarrosselService {
  /**
   * @param {object} deps
   * @param {{ buscarVendasPorData(data: string): Promise<*> }} deps.client
   * @param {object} deps.logger
   * @param {number} [deps.validadeFallbackMs] - Idade máxima do cache de fallback
   */
  constructor({ client, logger, validadeFallbackMs = 10 * 60_000 }) {
    this.client = client;
    this.log = logger;
    this.validadeFallbackMs = validadeFallbackMs;
    /** @type {Map<string, { vendedores: object[], em: number }>} */
    this.ultimoValido = new Map();
  }

  /**
   * Lista vendedores e seus totais de venda numa data.
   *
   * @param {string} data - YYYY-MM-DD
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.permitirFallback=true] - Usa o último resultado válido se a API falhar
   * @returns {Promise<{ vendedores: object[], origem: 'api'|'fallback' }>}
   * @throws {CarrosselIndisponivelError}
   */
  async listarVendas(data, { permitirFallback = true } = {}) {
    try {
      const payload = await this.client.buscarVendasPorData(data);
      const { vendedores, descartados } = mapearResposta(payload);

      if (descartados > 0) {
        this.log.aviso(`${descartados} registro(s) do Carrossel ignorado(s) por não terem ramal.`);
      }
      this.log.debug(`Carrossel ${data}: ${vendedores.length} vendedor(es).`);

      this.ultimoValido.set(data, { vendedores, em: Date.now() });
      this.limparCacheAntigo(data);
      return { vendedores, origem: 'api' };
    } catch (e) {
      const cache = this.ultimoValido.get(data);
      const cacheUtil = cache && Date.now() - cache.em <= this.validadeFallbackMs;

      if (permitirFallback && cacheUtil) {
        this.log.aviso(`Carrossel indisponível (${e.message}); usando dados de ${new Date(cache.em).toISOString()}.`);
        return { vendedores: cache.vendedores, origem: 'fallback' };
      }
      throw new CarrosselIndisponivelError(`Falha ao consultar vendas de ${data} no Carrossel: ${e.message}`, e);
    }
  }

  /** Mantém só a data atual no cache para não crescer indefinidamente. */
  limparCacheAntigo(dataAtual) {
    for (const k of this.ultimoValido.keys()) {
      if (k < dataAtual) this.ultimoValido.delete(k);
    }
  }
}

module.exports = { CarrosselService, CarrosselIndisponivelError };
