'use strict';
/**
 * Serviço de integração com o Carrossel.
 *
 * Expõe operações em linguagem de negócio ("vendas de ontem", "vendas de hoje")
 * e garante resiliência:
 *  - erros de rede/HTTP/formato viram `CarrosselIndisponivelError`;
 *  - mantém o último resultado válido de cada período como fallback.
 */

const { mapearRanking } = require('./carrossel.mapper');

class CarrosselIndisponivelError extends Error {
  constructor(mensagem, cause) {
    super(mensagem, { cause });
    this.name = 'CarrosselIndisponivelError';
  }
}

class CarrosselService {
  /**
   * @param {object} deps
   * @param {{ buscarRankingVendedores(): Promise<*> }} deps.client
   * @param {string} deps.metrica - Campo da linha GERAL usado como total (ex.: vendaConcluida)
   * @param {object} deps.logger
   * @param {number} [deps.validadeFallbackMs] - Idade máxima do cache de fallback
   */
  constructor({ client, metrica, logger, validadeFallbackMs = 10 * 60_000 }) {
    this.client = client;
    this.metrica = metrica;
    this.log = logger;
    this.validadeFallbackMs = validadeFallbackMs;
    /** @type {Map<string, { resultado: object, em: number }>} */
    this.ultimoValido = new Map();
  }

  /**
   * Lista as vendas de um período (o Carrossel só lista quem vendeu nele).
   *
   * @param {'hoje'|'ontem'} periodo
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.permitirFallback=true]
   * @returns {Promise<{
   *   vendedores: Array<{ nome, chave, equipe, totalVendas }>,
   *   diaOntem: string|null,
   *   ultimaExtracao: string|null,
   *   origem: 'api'|'fallback'
   * }>}
   * @throws {CarrosselIndisponivelError}
   */
  async listarVendas(periodo, { permitirFallback = true } = {}) {
    let ranking;
    try {
      ranking = mapearRanking(await this.client.buscarRankingVendedores(), periodo, this.metrica);
    } catch (e) {
      return this.usarFallback(periodo, e, permitirFallback);
    }

    if (ranking.descartados > 0) this.log.aviso(`${ranking.descartados} registro(s) do Carrossel ignorado(s) por não terem nome.`);
    this.log.debug(`Carrossel "${periodo}": ${ranking.vendedores.length} vendedor(es) (extração: ${ranking.ultimaExtracao}).`);

    const resultado = { vendedores: ranking.vendedores, diaOntem: ranking.diaOntem, ultimaExtracao: ranking.ultimaExtracao };
    this.ultimoValido.set(periodo, { resultado, em: Date.now() });
    return { ...resultado, origem: 'api' };
  }

  /**
   * Devolve o último resultado válido do período, se permitido e recente.
   * @throws {CarrosselIndisponivelError} quando não há fallback utilizável
   */
  usarFallback(periodo, erro, permitido) {
    const cache = this.ultimoValido.get(periodo);
    const utilizavel = permitido && cache && Date.now() - cache.em <= this.validadeFallbackMs;
    if (!utilizavel) {
      throw new CarrosselIndisponivelError(`Falha ao consultar vendas de "${periodo}" no Carrossel: ${erro.message}`, erro);
    }

    this.log.aviso(`Carrossel indisponível (${erro.message}); usando dados de ${new Date(cache.em).toISOString()}.`);
    return { ...cache.resultado, origem: 'fallback' };
  }
}

module.exports = { CarrosselService, CarrosselIndisponivelError };
