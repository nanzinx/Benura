'use strict';
/**
 * Modo "URA cheia": a supervisão pede a URA cheia. [NOVO] Enquanto ligado,
 * qualquer operador que atender no Ativo sobe para a URA, sem olhar elegíveis
 * (meta, venda, fixo). Ninguém sobe só por estar no Ativo: quem voltou por
 * ocioso ou foi tirado à mão fica lá até atender. A regra do ocioso continua
 * valendo (URA_CHEIA_TEMPO_MIN); os robôs continuam proporcionais aos livres.
 *
 * [NOVO] "Sem saída" (só com a URA cheia ligada): o rodízio de saída fica desligado. Quem entra na
 * URA não volta ao Ativo sozinho: nem pelo ocioso, nem pelo excesso da URA calma, nem por ficar
 * offline. Mover à mão pelo painel continua valendo. Desligar a URA cheia desliga junto.
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
    this.estado = {}; // { data: 'AAAA-MM-DD', desde: ISO, semSaida?: { desde: ISO } } quando ligado
  }

  carregar(agora = new Date()) {
    this.estado = this.repositorio.carregar();
    if (this.ativa(agora)) this.log.aviso(`URA cheia continua ligada (desde ${this.estado.desde}): quem atender no Ativo sobe para a URA.`);
    return this;
  }

  /** Liga e grava. @returns {boolean} true se acabou de ligar (false = já estava) */
  ligar(agora = new Date()) {
    if (this.ativa(agora)) return false;
    this.estado = { data: dataLocal(this.fusoHorario, agora), desde: agora.toISOString() };
    this.repositorio.salvar(this.estado);
    this.log.aviso('URA cheia ligada: quem atender no Ativo sobe para a URA (sem olhar elegíveis); quem ficar ocioso volta ao Ativo e sobe de novo ao atender lá.');
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

  /**
   * [NOVO] Liga ou desliga o "sem saída" (ninguém volta ao Ativo sozinho). Só com a URA cheia ligada.
   * @returns {boolean} true se mudou
   * @throws {Error} ligar com a URA cheia desligada
   */
  definirSemSaida(ligar, agora = new Date()) {
    if (ligar && !this.ativa(agora)) throw new Error('Ligue a URA cheia antes de desligar o rodízio de saída.');
    if (Boolean(this.estado.semSaida) === Boolean(ligar)) return false;
    this.estado = { ...this.estado, semSaida: ligar ? { desde: agora.toISOString() } : undefined };
    if (!ligar) delete this.estado.semSaida;
    this.repositorio.salvar(this.estado);
    this.log.aviso(ligar
      ? 'URA cheia SEM SAÍDA: o rodízio de saída está desligado; quem entra na URA não volta ao Ativo sozinho (nem pelo ocioso).'
      : 'URA cheia: o rodízio de saída voltou; a regra do ocioso vale de novo.');
    return true;
  }

  /** [NOVO] O rodízio de saída está desligado (só vale com a URA cheia ligada hoje). */
  semSaida(agora = new Date()) {
    return this.ativa(agora) && Boolean(this.estado.semSaida);
  }

  /** Ligada hoje. Ligada num dia anterior = desliga sozinha. */
  ativa(agora = new Date()) {
    if (!this.estado.data) return false;
    if (this.estado.data === dataLocal(this.fusoHorario, agora)) return true;
    this.desligar('virou o dia');
    return false;
  }

  resumo(agora = new Date()) {
    const ligada = this.ativa(agora);
    return { ligada, desde: this.estado.desde ?? null, semSaida: ligada && Boolean(this.estado.semSaida), semSaidaDesde: (ligada && this.estado.semSaida?.desde) || null };
  }
}

module.exports = { UraCheia };
