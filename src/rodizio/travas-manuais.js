'use strict';
/**
 * [NOVO] Trava manual: quem a supervisão mexeu à mão pelo painel (mandou para o
 * Ativo ou trouxe para a URA) fica onde foi posto. O rodízio não mexe nele (nem
 * o ocioso, nem a URA cheia, nem o "Retomar rodízio") e o roteador não sobe a
 * venda de quem está travado no Ativo, até alguém clicar em "Liberar para o
 * rodízio" ou virar o dia.
 *
 * Fica em TRAVAS_MANUAIS_FILE: o rodízio grava, o roteador lê (utils/automacao.js, lerTravas).
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { dataLocal } = require('../utils/datas');

const ONDE = new Set(['ativo', 'ura']);

class TravasManuais {
  /**
   * @param {object} deps
   * @param {string|null} deps.arquivo
   * @param {string} deps.fusoHorario
   * @param {object} deps.logger
   */
  constructor({ arquivo, fusoHorario, logger }) {
    Object.assign(this, { fusoHorario, log: logger });
    this.repositorio = arquivo ? new ArquivoDeEstado({ arquivo, logger }) : null;
    this.estado = { dia: null, ramais: {} };
  }

  carregar(agora = new Date()) {
    const salvo = this.repositorio?.carregar() || {};
    if (salvo.dia && salvo.ramais && typeof salvo.ramais === 'object') this.estado = { dia: salvo.dia, ramais: salvo.ramais };
    const qtd = Object.keys(this.doDia(agora)).length;
    if (qtd) this.log.aviso(`${qtd} operador(es) continuam travados à mão pelo painel: o rodízio não mexe neles até liberarem.`);
    return this;
  }

  /** As travas de hoje (virou o dia: zera). */
  doDia(agora = new Date()) {
    const hoje = dataLocal(this.fusoHorario, agora);
    if (this.estado.dia !== hoje) {
      const tinha = Object.keys(this.estado.ramais).length > 0;
      this.estado = { dia: hoje, ramais: {} };
      if (tinha) {
        this.log.info('Virou o dia: as travas manuais do painel foram liberadas.');
        this.gravar();
      }
    }
    return this.estado.ramais;
  }

  /** @returns {'ativo'|'ura'|null} */
  onde(ramal, agora = new Date()) {
    return this.doDia(agora)[String(ramal)]?.onde ?? null;
  }

  /** @returns {Promise<void>} espera gravar: o roteador lê o arquivo */
  async travar(ramal, onde, por = null, agora = new Date()) {
    if (!ONDE.has(onde)) throw new Error(`trava inválida: ${onde}`);
    this.doDia(agora)[String(ramal)] = { onde, desde: agora.toISOString(), por };
    await this.gravar();
  }

  /** @returns {Promise<boolean>} true se estava travado */
  async liberar(ramal, agora = new Date()) {
    const ramais = this.doDia(agora);
    if (!ramais[String(ramal)]) return false;
    delete ramais[String(ramal)];
    await this.gravar();
    return true;
  }

  async gravar() {
    if (!this.repositorio) return;
    this.repositorio.salvar(this.estado);
    await this.repositorio.aguardar();
  }

  /** @returns {Record<string, { onde: string, desde: string, por: string|null }>} */
  resumo(agora = new Date()) {
    return structuredClone(this.doDia(agora));
  }
}

module.exports = { TravasManuais };
