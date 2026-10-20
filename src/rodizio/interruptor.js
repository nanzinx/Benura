'use strict';
/**
 * Interruptor liga/desliga da supervisão (ex.: pânico dos robôs), gravado em
 * arquivo: um reinício do BenURA mantém a última escolha. Sem arquivo, vale o padrão.
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');

class Interruptor {
  /**
   * @param {object} deps
   * @param {string} deps.nome - para o log (ex.: "Pânico dos robôs")
   * @param {string} deps.arquivo
   * @param {boolean} deps.padrao
   * @param {object} deps.logger
   */
  constructor({ nome, arquivo, padrao, logger }) {
    Object.assign(this, { nome, padrao: Boolean(padrao), log: logger });
    this.repositorio = arquivo ? new ArquivoDeEstado({ arquivo, logger }) : null;
    this.estado = {}; // { ligado: boolean, desde: ISO }
  }

  carregar() {
    this.estado = this.repositorio?.carregar() || {};
    return this;
  }

  ligado() {
    return typeof this.estado.ligado === 'boolean' ? this.estado.ligado : this.padrao;
  }

  /** @returns {boolean} true se mudou */
  definir(ligado, agora = new Date()) {
    if (this.ligado() === ligado) return false;
    this.estado = { ligado, desde: agora.toISOString() };
    this.repositorio?.salvar(this.estado);
    this.log.aviso(`${this.nome} ${ligado ? 'ligado' : 'desligado'} pela supervisão.`);
    return true;
  }

  resumo() {
    return { ligado: this.ligado(), desde: this.estado.desde ?? null };
  }
}

module.exports = { Interruptor };
