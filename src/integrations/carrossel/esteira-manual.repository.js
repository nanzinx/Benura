'use strict';
/**
 * Esteiras coladas à mão (redundância do Carrossel), salvas em arquivo para
 * sobreviver a reinícios. Cada colagem substitui os dias que contém e mantém
 * os demais: dá para colar a esteira de ontem e a de hoje separadamente.
 * Guarda os 7 dias mais recentes; `limpar` apaga tudo.
 */

const { ArquivoDeEstado } = require('../../utils/persistencia-json');
const { lerEsteira, totaisPorDia, unirDias } = require('../../domain/esteira-manual');

const DIAS_GUARDADOS = 7;
const VAZIO = Object.freeze({ dias: {}, coladaEm: null, coladaNoDia: null });

class EsteiraManualRepository {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.arquivo = new ArquivoDeEstado({ arquivo, logger, padrao: VAZIO });
    this.estado = this.arquivo.carregar();
  }

  /** @returns {Record<string, object>} dia → agente → { nome, total } */
  dias() {
    return this.estado.dias || {};
  }

  coladaEm() {
    return this.estado.coladaEm;
  }

  /** Só vale a esteira colada hoje: uma de dias atrás daria um "ontem" velho. */
  coladaHoje(hoje) {
    return this.estado.coladaNoDia === hoje;
  }

  /**
   * Lê e guarda uma esteira colada.
   * @param {string} texto
   * @param {string} hoje - YYYY-MM-DD no fuso do expediente
   * @returns {Promise<{ dias: string[], vendas: number, ignoradas: number }>}
   * @throws {import('../../domain/esteira-manual').EsteiraInvalidaError}
   */
  async colar(texto, hoje, agora = new Date()) {
    const { vendas, ignoradas } = lerEsteira(texto);
    const novos = totaisPorDia(vendas);
    this.estado = { dias: unirDias(this.dias(), novos, DIAS_GUARDADOS), coladaEm: agora.toISOString(), coladaNoDia: hoje };
    await this.arquivo.salvar(this.estado);
    return { dias: Object.keys(novos).sort(), vendas: vendas.length, ignoradas };
  }

  /**
   * Apaga todas as esteiras coladas. Sem esteira colada hoje, a redundância
   * deixa de usá-la e um Carrossel fora do ar volta a dar erro.
   * @returns {Promise<number>} quantos dias foram apagados
   */
  async limpar() {
    const apagados = Object.keys(this.dias()).length;
    this.estado = structuredClone(VAZIO);
    await this.arquivo.salvar(this.estado);
    return apagados;
  }
}

module.exports = { EsteiraManualRepository };
