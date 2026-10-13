'use strict';
/**
 * Cliente do Carrossel com redundância: se a API falhar (ou responder
 * ultimaExtracao "Erro") e houver esteira colada à mão, devolve o ranking
 * montado da esteira, no mesmo formato. O Carrossel continua sendo a fonte
 * principal: assim que volta, a esteira deixa de ser usada.
 */

const { rankingDaEsteira, ultimoDiaAntes } = require('../../domain/esteira-manual');

class CarrosselComRedundancia {
  /**
   * @param {object} deps
   * @param {{ buscarRankingVendedores(): Promise<*> }} deps.client - Cliente do Carrossel
   * @param {import('./esteira-manual.repository').EsteiraManualRepository} deps.esteira
   * @param {{ hoje(): string }} deps.relogio
   * @param {string} deps.metrica
   * @param {object} deps.logger
   */
  constructor({ client, esteira, relogio, metrica, logger }) {
    Object.assign(this, { client, esteira, relogio, metrica, log: logger });
    this.usandoEsteira = false;
  }

  async buscarRankingVendedores() {
    let payload;
    try {
      payload = await this.client.buscarRankingVendedores();
    } catch (e) {
      return this.daEsteira(e);
    }
    if (payload?.ultimaExtracao === 'Erro') return this.daEsteira(new Error('o Carrossel reportou ultimaExtracao "Erro"'), payload);

    if (this.usandoEsteira) {
      this.log.aviso('Carrossel voltou: a esteira colada deixa de ser usada. As decisões tomadas com ela continuam valendo '
        + '(critérios diferentes: Valor Contrato em Andamento × vendaConcluida). Confira GET /status e, se a carga do dia '
        + 'usou dados incompletos, refaça com POST /recarregar.');
    }
    this.usandoEsteira = false;
    return payload;
  }

  /** Ranking da esteira colada; sem esteira útil, repassa o erro (ou a resposta) original. */
  daEsteira(erro, respostaOriginal) {
    const dias = this.esteira.dias();
    const hoje = this.relogio.hoje();
    const util = this.esteira.coladaHoje(hoje) && (dias[hoje] || ultimoDiaAntes(dias, hoje));
    if (!util && respostaOriginal) return respostaOriginal;
    if (!util) throw erro;

    if (!this.usandoEsteira) this.log.aviso(`Carrossel indisponível (${erro.message}); usando a esteira colada em /manual.`);
    this.usandoEsteira = true;
    return rankingDaEsteira(dias, hoje, this.metrica, `em ${this.esteira.coladaEm()}`);
  }
}

module.exports = { CarrosselComRedundancia };
