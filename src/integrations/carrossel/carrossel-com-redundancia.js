'use strict';
/**
 * Cliente do Carrossel com redundância: se a API falhar (ou responder
 * ultimaExtracao "Erro") e houver esteira colada à mão, devolve o ranking
 * montado da esteira, no mesmo formato. O Carrossel continua sendo a fonte
 * principal: assim que volta, a esteira deixa de ser usada.
 */

const { rankingDaEsteira, ultimoDiaAntes } = require('../../domain/esteira-manual');
const { deDiaBr, diaUtil, SEM_EXTRAS } = require('../../domain/calendario');

class CarrosselComRedundancia {
  /**
   * @param {object} deps
   * @param {{ buscarRankingVendedores(): Promise<*> }} deps.client - Cliente do Carrossel
   * @param {import('./esteira-manual.repository').EsteiraManualRepository} deps.esteira
   * @param {{ hoje(): string }} deps.relogio
   * @param {string} deps.metrica
   * @param {object} deps.logger
   * @param {object} [deps.feriadosExtras] - FERIADOS_EXTRAS (calendario.lerFeriadosExtras)
   */
  constructor({ client, esteira, relogio, metrica, logger, feriadosExtras = SEM_EXTRAS }) {
    Object.assign(this, { client, esteira, relogio, metrica, log: logger, feriadosExtras });
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
    return this.ontemDoDiaUtil(payload);
  }

  /**
   * [NOVO] O Carrossel no ar, mas mandando um feriado ou fim de semana como "ontem" (ex.: 02/11): com uma
   * esteira colada hoje, o "ontem" vem dela (o dia útil) e o "hoje" segue do Carrossel, ao vivo. Sem esteira,
   * a resposta segue como veio, e o roteador adia a carga e avisa.
   */
  ontemDoDiaUtil(payload) {
    const dia = deDiaBr(payload?.diaOntem);
    if (!dia || diaUtil(dia, this.feriadosExtras)) return payload;
    const dias = this.esteira.dias();
    const hoje = this.relogio.hoje();
    if (!this.esteira.coladaHoje(hoje) || !ultimoDiaAntes(dias, hoje, this.feriadosExtras)) return payload;
    const daEsteira = rankingDaEsteira(dias, hoje, this.metrica, `em ${this.esteira.coladaEm()}`, this.feriadosExtras);
    this.log.aviso(`O Carrossel mandou ${payload.diaOntem} (não é dia útil) como dia anterior: usando o ${daEsteira.diaOntem} da esteira colada.`);
    return { ...payload, ontem: daEsteira.ontem, diaOntem: daEsteira.diaOntem, ultimaExtracao: `${daEsteira.ultimaExtracao} (dia anterior) · Carrossel ${payload.ultimaExtracao}` };
  }

  /** Ranking da esteira colada; sem esteira útil, repassa o erro (ou a resposta) original. */
  daEsteira(erro, respostaOriginal) {
    const dias = this.esteira.dias();
    const hoje = this.relogio.hoje();
    const util = this.esteira.coladaHoje(hoje) && (dias[hoje] || ultimoDiaAntes(dias, hoje, this.feriadosExtras));
    if (!util && respostaOriginal) return respostaOriginal;
    if (!util) throw erro;

    if (!this.usandoEsteira) this.log.aviso(`Carrossel indisponível (${erro.message}); usando a esteira colada em /manual.`);
    this.usandoEsteira = true;
    return rankingDaEsteira(dias, hoje, this.metrica, `em ${this.esteira.coladaEm()}`, this.feriadosExtras);
  }
}

module.exports = { CarrosselComRedundancia };
