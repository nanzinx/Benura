'use strict';
/**
 * Agendador do ciclo diário.
 *
 * Um único loop (setTimeout encadeado, sem sobreposição de execuções) decide
 * a cada tick o que fazer:
 *   - fora do expediente           → nada
 *   - carga do dia ainda não feita → executa a carga inicial
 *   - caso contrário               → um ciclo de monitoramento
 *
 * Isso substitui os dois setInterval da versão anterior e cobre o reset
 * diário: ao virar o dia, `cargaInicialFeitaHoje()` passa a ser falso.
 */

const { horaLocal, dentroDoIntervalo } = require('../utils/datas');

class Agendador {
  /**
   * @param {object} deps
   * @param {import('./roteamento.service').RoteamentoService} deps.roteamento
   * @param {object} deps.agenda - Seção `agenda` da configuração
   * @param {object} deps.logger
   */
  constructor({ roteamento, agenda, logger }) {
    this.roteamento = roteamento;
    this.agenda = agenda;
    this.log = logger;
    this.timer = null;
    this.ativo = false;
    this.execucaoAtual = Promise.resolve();
  }

  dentroDoExpediente() {
    const { fusoHorario, horarioCarga, horarioFim } = this.agenda;
    return dentroDoIntervalo(horaLocal(fusoHorario), horarioCarga, horarioFim);
  }

  async tick() {
    if (!this.dentroDoExpediente()) return this.log.debug('Fora do expediente; aguardando.');

    try {
      await this.executarEtapaDoDia();
    } catch (e) {
      // Nenhuma falha de integração derruba o loop: registra e tenta no próximo tick.
      this.log.erro(e.message);
    }
  }

  /** Carga inicial enquanto não tiver sido feita hoje; depois, monitoramento. */
  async executarEtapaDoDia() {
    if (!this.roteamento.cargaInicialFeitaHoje()) return this.roteamento.executarCargaInicial();

    const { promovidos } = await this.roteamento.monitorarVendas();
    this.log.debug(`Ciclo de monitoramento concluído (${promovidos} promovido(s)).`);
  }

  iniciar() {
    if (this.ativo) return;
    this.ativo = true;
    this.log.info(`Agendador iniciado: a cada ${this.agenda.pollVendasMs / 1000}s, das ${this.agenda.horarioCarga} às ${this.agenda.horarioFim} (${this.agenda.fusoHorario}).`);

    const loop = async () => {
      if (!this.ativo) return;
      this.execucaoAtual = this.tick();
      await this.execucaoAtual;
      if (this.ativo) this.timer = setTimeout(loop, this.agenda.pollVendasMs);
    };
    loop();
  }

  /** Para o loop e aguarda o tick em andamento terminar. */
  async parar() {
    this.ativo = false;
    clearTimeout(this.timer);
    await this.execucaoAtual;
  }
}

module.exports = { Agendador };
