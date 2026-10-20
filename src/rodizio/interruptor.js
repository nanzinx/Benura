'use strict';
/**
 * Interruptor liga/desliga da supervisão (ex.: pânico dos robôs), gravado em
 * arquivo: um reinício do BenURA mantém a última escolha. Sem arquivo, vale o padrão.
 * Com `fusoHorario`, a escolha vale só no dia (ex.: "URA passiva hoje"): na
 * virada do dia volta ao padrão sozinha.
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { dataLocal } = require('../utils/datas');

class Interruptor {
  /**
   * @param {object} deps
   * @param {string} deps.nome - para o log (ex.: "Pânico dos robôs")
   * @param {string} deps.arquivo
   * @param {boolean} deps.padrao
   * @param {string} [deps.fusoHorario] - a escolha vale só no dia em que foi feita
   * @param {object} deps.logger
   */
  constructor({ nome, arquivo, padrao, fusoHorario = null, logger }) {
    Object.assign(this, { nome, padrao: Boolean(padrao), fusoHorario, log: logger });
    this.repositorio = arquivo ? new ArquivoDeEstado({ arquivo, logger }) : null;
    this.estado = {}; // { ligado: boolean, desde: ISO, data?: 'AAAA-MM-DD' }
  }

  carregar() {
    this.estado = this.repositorio?.carregar() || {};
    return this;
  }

  /** Há escolha da supervisão valendo agora (com `fusoHorario`, só a de hoje). */
  escolhaValendo(agora = new Date()) {
    if (typeof this.estado.ligado !== 'boolean') return false;
    return !this.fusoHorario || this.estado.data === dataLocal(this.fusoHorario, agora);
  }

  ligado(agora = new Date()) {
    return this.escolhaValendo(agora) ? this.estado.ligado : this.padrao;
  }

  /** @returns {boolean} true se mudou */
  definir(ligado, agora = new Date()) {
    if (this.ligado(agora) === ligado) return false;
    this.estado = { ligado, desde: agora.toISOString(), ...(this.fusoHorario && { data: dataLocal(this.fusoHorario, agora) }) };
    this.repositorio?.salvar(this.estado);
    this.log.aviso(`${this.nome} ${ligado ? 'ligado' : 'desligado'} pela supervisão${this.fusoHorario ? ' (vale só hoje)' : ''}.`);
    return true;
  }

  resumo(agora = new Date()) {
    return { ligado: this.ligado(agora), desde: this.escolhaValendo(agora) ? (this.estado.desde ?? null) : null };
  }
}

module.exports = { Interruptor };
