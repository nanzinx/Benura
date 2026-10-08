'use strict';
/**
 * Serviço de integração com o Carrossel.
 *
 * Expõe operações em linguagem de negócio ("vendas de ontem", "vendas de hoje")
 * já com o ramal de cada vendedor resolvido, e garante resiliência:
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
   * @param {import('../../repositories/cadastro-ramais.repository').CadastroRamaisRepository} deps.cadastro
   * @param {string} deps.metrica - Campo da linha GERAL usado como total (ex.: vendaConcluida)
   * @param {object} deps.logger
   * @param {number} [deps.validadeFallbackMs] - Idade máxima do cache de fallback
   */
  constructor({ client, cadastro, metrica, logger, validadeFallbackMs = 10 * 60_000 }) {
    this.client = client;
    this.cadastro = cadastro;
    this.metrica = metrica;
    this.log = logger;
    this.validadeFallbackMs = validadeFallbackMs;
    /** @type {Map<string, { resultado: object, em: number }>} */
    this.ultimoValido = new Map();
    /** Nomes sem ramal já avisados (evita repetir o aviso a cada ciclo). */
    this.naoCadastradosAvisados = new Set();
  }

  /**
   * Lista as vendas de um período, com o ramal de cada vendedor.
   *
   * Vendedores sem cadastro de ramal vêm em `naoCadastrados` e NÃO em `vendedores`.
   * Lembre-se: o Carrossel só lista quem vendeu no período.
   *
   * @param {'hoje'|'ontem'} periodo
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.permitirFallback=true]
   * @returns {Promise<{
   *   vendedores: Array<{ nome, chave, equipe, totalVendas, ramal }>,
   *   naoCadastrados: string[],
   *   diaOntem: string|null,
   *   ultimaExtracao: string|null,
   *   origem: 'api'|'fallback'
   * }>}
   * @throws {CarrosselIndisponivelError}
   */
  async listarVendas(periodo, { permitirFallback = true } = {}) {
    let ranking;
    try {
      const payload = await this.client.buscarRankingVendedores();
      ranking = mapearRanking(payload, periodo, this.metrica);
    } catch (e) {
      const cache = this.ultimoValido.get(periodo);
      if (permitirFallback && cache && Date.now() - cache.em <= this.validadeFallbackMs) {
        this.log.aviso(`Carrossel indisponível (${e.message}); usando dados de ${new Date(cache.em).toISOString()}.`);
        return { ...cache.resultado, origem: 'fallback' };
      }
      throw new CarrosselIndisponivelError(`Falha ao consultar vendas de "${periodo}" no Carrossel: ${e.message}`, e);
    }

    if (ranking.descartados > 0) {
      this.log.aviso(`${ranking.descartados} registro(s) do Carrossel ignorado(s) por não terem nome.`);
    }

    this.cadastro.atualizar();
    const vendedores = [];
    const naoCadastrados = [];
    for (const v of ranking.vendedores) {
      const ramal = this.cadastro.ramalDe(v.nome);
      if (ramal) {
        vendedores.push({ ...v, ramal });
      } else {
        naoCadastrados.push(v.nome);
        if (!this.naoCadastradosAvisados.has(v.chave)) {
          this.naoCadastradosAvisados.add(v.chave);
          this.log.aviso(`Vendedor "${v.nome}" está no Carrossel mas não tem ramal cadastrado; será ignorado.`);
        }
      }
    }

    this.log.debug(`Carrossel "${periodo}": ${vendedores.length} com ramal, ${naoCadastrados.length} sem cadastro `
      + `(extração: ${ranking.ultimaExtracao}).`);

    const resultado = {
      vendedores, naoCadastrados, diaOntem: ranking.diaOntem, ultimaExtracao: ranking.ultimaExtracao,
    };
    this.ultimoValido.set(periodo, { resultado, em: Date.now() });
    return { ...resultado, origem: 'api' };
  }
}

module.exports = { CarrosselService, CarrosselIndisponivelError };
