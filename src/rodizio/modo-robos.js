'use strict';
/**
 * [NOVO] Modo dos robôs escolhido no painel (aba "URA e robôs", "Rodízio dos robôs"):
 *  - automatico: o BenURA liga e desliga sozinho, na ordem, proporcional aos livres;
 *  - panico: a supervisão liga pela Argus; o BenURA só desliga no pânico;
 *  - desligados: o BenURA desliga os robôs (os parados na hora, os em ligação ao
 *    terminar) e mantém todos desligados; o resto da automação segue normal.
 * Fica em ROBOS_MODO_FILE e vale até alguém trocar (inclusive depois de reiniciar).
 * Sem escolha gravada, vale o ROBOS_MODO do .env.
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');

const MODOS = Object.freeze(['automatico', 'panico', 'desligados']);

class ModoRobos {
  /**
   * @param {object} deps
   * @param {string|null} deps.arquivo
   * @param {'automatico'|'panico'} deps.padrao - o ROBOS_MODO do .env
   * @param {object} deps.logger
   */
  constructor({ arquivo, padrao, logger }) {
    this.log = logger;
    this.repositorio = arquivo ? new ArquivoDeEstado({ arquivo, logger }) : null;
    this.padrao = MODOS.includes(padrao) ? padrao : 'panico';
    this.estado = { modo: this.padrao, desde: null, por: null, escolhido: false };
  }

  carregar() {
    const salvo = this.repositorio?.carregar() || {};
    if (MODOS.includes(salvo.modo)) this.estado = { modo: salvo.modo, desde: salvo.desde ?? null, por: salvo.por ?? null, escolhido: true };
    if (this.estado.modo === 'desligados') this.log.aviso(`Robôs desligados pelo painel${this.estado.por ? ` (${this.estado.por})` : ''}: o BenURA mantém todos desligados até alguém trocar.`);
    return this;
  }

  get modo() {
    return this.estado.modo;
  }

  /** @returns {{ mudou: boolean }} */
  definir(modo, por = null, agora = new Date()) {
    if (!MODOS.includes(modo)) throw new Error(`modo deve ser ${MODOS.join(', ')}`);
    if (modo === this.estado.modo && this.estado.escolhido) return { mudou: false };
    this.estado = { modo, desde: agora.toISOString(), por, escolhido: true };
    this.repositorio?.salvar({ modo, desde: this.estado.desde, por });
    return { mudou: true };
  }

  resumo() {
    return { ...this.estado, padrao: this.padrao };
  }
}

module.exports = { ModoRobos, MODOS };
