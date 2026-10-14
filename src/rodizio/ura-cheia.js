'use strict';
/**
 * Modo "URA cheia": a supervisão pede todo mundo na URA (como na operação
 * manual). Enquanto ligado, o rodízio leva todos os operadores do Ativo para a
 * URA uma vez e qualquer um que atender no Ativo volta, sem olhar elegíveis. A
 * regra do ocioso continua valendo; os robôs continuam proporcionais aos livres.
 *
 * Fica gravado em arquivo (sobrevive a reinício) e vale só para o dia em que
 * foi ligado: na virada do dia o rodízio volta ao normal sozinho.
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { dataLocal } = require('../utils/datas');

class UraCheia {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo
   * @param {string} deps.fusoHorario
   * @param {object} deps.logger
   */
  constructor({ arquivo, fusoHorario, logger }) {
    Object.assign(this, { fusoHorario, log: logger });
    this.repositorio = new ArquivoDeEstado({ arquivo, logger });
    this.estado = {}; // { data: 'AAAA-MM-DD', desde: ISO } quando ligado
  }

  carregar(agora = new Date()) {
    this.estado = this.repositorio.carregar();
    if (this.ativa(agora)) this.log.aviso(`URA cheia continua ligada (desde ${this.estado.desde}): todos do Ativo vão para a URA.`);
    return this;
  }

  /** Liga e grava. @returns {boolean} true se acabou de ligar (false = já estava) */
  ligar(agora = new Date()) {
    if (this.ativa(agora)) return false;
    this.estado = { data: dataLocal(this.fusoHorario, agora), desde: agora.toISOString() };
    this.repositorio.salvar(this.estado);
    this.log.aviso('URA cheia ligada: todos do Ativo vão para a URA; quem ficar ocioso volta ao Ativo e sobe de novo ao atender lá.');
    return true;
  }

  /** @returns {boolean} true se estava ligada */
  desligar(motivo = 'pedido da supervisão') {
    if (!this.estado.data) return false;
    this.estado = {};
    this.repositorio.salvar(this.estado);
    this.log.aviso(`URA cheia desligada (${motivo}): só os elegíveis sobem do Ativo para a URA.`);
    return true;
  }

  /** Ligada hoje. Ligada num dia anterior = desliga sozinha. */
  ativa(agora = new Date()) {
    if (!this.estado.data) return false;
    if (this.estado.data === dataLocal(this.fusoHorario, agora)) return true;
    this.desligar('virou o dia');
    return false;
  }

  resumo(agora = new Date()) {
    return { ligada: this.ativa(agora), desde: this.estado.desde ?? null };
  }
}

module.exports = { UraCheia };
