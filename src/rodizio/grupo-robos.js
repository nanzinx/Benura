'use strict';
/**
 * Grupo de robôs da URA escolhido manualmente no painel:
 *  - null: automático / todos os grupos URA PORT detectados;
 *  - number: ID de um grupo específico selecionado pela supervisão.
 *
 * Fica em ROBOS_GRUPO_FILE e vale até alguém trocar (inclusive após reiniciar).
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');

class GrupoRobos {
  /**
   * @param {object} deps
   * @param {string|null} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.log = logger;
    this.repositorio = arquivo ? new ArquivoDeEstado({ arquivo, logger }) : null;
    this.estado = { grupoId: null, desde: null, por: null, escolhido: false };
  }

  carregar() {
    const salvo = this.repositorio?.carregar() || {};
    const id = salvo.grupoId != null ? Number(salvo.grupoId) : null;
    if (Number.isInteger(id) && id > 0) {
      this.estado = { grupoId: id, desde: salvo.desde ?? null, por: salvo.por ?? null, escolhido: true };
    } else {
      this.estado = { grupoId: null, desde: null, por: null, escolhido: false };
    }
    return this;
  }

  get grupoId() {
    return this.estado.grupoId;
  }

  /**
   * Define o grupo de robôs a controlar.
   *
   * @param {number|string|null} grupoId null ou "todos" para automático, ou ID numérico
   * @param {string|null} [por] quem pediu (e-mail/IP)
   * @param {Date} [agora]
   * @returns {{ mudou: boolean, grupoId: number|null }}
   */
  definir(grupoId, por = null, agora = new Date()) {
    let novo = null;
    if (grupoId != null && grupoId !== 'todos' && grupoId !== '' && grupoId !== 0 && grupoId !== '0') {
      const num = Number(grupoId);
      if (Number.isInteger(num) && num > 0) {
        novo = num;
      }
    }

    if (novo === this.estado.grupoId && this.estado.escolhido === (novo != null)) {
      return { mudou: false, grupoId: this.estado.grupoId };
    }

    this.estado = {
      grupoId: novo,
      desde: novo != null ? agora.toISOString() : null,
      por: novo != null ? por : null,
      escolhido: novo != null,
    };
    this.repositorio?.salvar({ grupoId: novo, desde: this.estado.desde, por: this.estado.por });
    return { mudou: true, grupoId: novo };
  }

  aguardar() {
    return this.repositorio?.aguardar();
  }

  resumo() {
    return { ...this.estado };
  }
}

module.exports = { GrupoRobos };
