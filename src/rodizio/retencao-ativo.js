'use strict';
/**
 * [NOVO] Retenção no Ativo: depois do "Alocar Todos no Ativo", ninguém sobe para a
 * URA (nem pelo rodízio nem pelo roteador) até alguém clicar em "Retomar rodízio
 * da URA". Fica gravada em RETENCAO_ATIVO_FILE e não vira com o dia: vale até
 * retomarem. O roteador lê o mesmo arquivo (utils/automacao.js, lerRetencao).
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');

class RetencaoAtivo {
  /**
   * @param {object} deps
   * @param {string|null} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.log = logger;
    this.repositorio = arquivo ? new ArquivoDeEstado({ arquivo, logger }) : null;
    this.estado = { ativa: false, desde: null, por: null };
  }

  carregar() {
    const salvo = this.repositorio?.carregar() || {};
    if (salvo.ativa === true) this.estado = { ativa: true, desde: salvo.desde ?? null, por: salvo.por ?? null };
    return this;
  }

  get ativa() {
    return this.estado.ativa;
  }

  /** @returns {Promise<boolean>} true se mudou (espera gravar: o roteador lê o arquivo) */
  async ligar(por = null, agora = new Date()) {
    if (this.estado.ativa) return false;
    this.estado = { ativa: true, desde: agora.toISOString(), por };
    await this.gravar();
    this.log.aviso(`Rodízio pausado: todos no Ativo${por ? ` (${por})` : ''}. Ninguém sobe para a URA até "Retomar rodízio da URA".`);
    return true;
  }

  /** @returns {Promise<boolean>} true se mudou */
  async desligar(por = null) {
    if (!this.estado.ativa) return false;
    this.estado = { ativa: false, desde: null, por: null };
    await this.gravar();
    this.log.aviso(`Rodízio da URA retomado${por ? ` (${por})` : ''}.`);
    return true;
  }

  async gravar() {
    if (!this.repositorio) return;
    this.repositorio.salvar(this.estado);
    await this.repositorio.aguardar();
  }

  resumo() {
    return { ...this.estado };
  }
}

module.exports = { RetencaoAtivo };
