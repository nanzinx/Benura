'use strict';
/**
 * [NOVO] Status da URA que vale para o pânico: o do termômetro (modo automático) ou
 * o que a supervisão escolheu no painel (modo manual, até alguém voltar ao
 * automático). Gravado em arquivo: todos no painel veem o mesmo, e um reinício
 * mantém a escolha.
 *
 * Calma = como a antiga "URA passiva": com 1 fixo livre, os robôs seguem até ele
 * atender. Normal e agressiva = a regra do fixo inteira.
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');

const STATUS = Object.freeze(['calma', 'normal', 'agressiva']);
const MODOS = Object.freeze(['automatico', 'manual']);

class StatusUra {
  /**
   * @param {object} deps
   * @param {string|null} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.log = logger;
    this.repositorio = arquivo ? new ArquivoDeEstado({ arquivo, logger }) : null;
    this.escolha = { modo: 'automatico', status: null, desde: null, por: null };
  }

  carregar() {
    const salvo = this.repositorio?.carregar() || {};
    if (salvo.modo === 'manual' && STATUS.includes(salvo.status)) this.escolha = { ...this.escolha, ...salvo };
    return this;
  }

  get manual() {
    return this.escolha.modo === 'manual';
  }

  /**
   * @param {{ status?: string, modo: string }} pedido
   * @param {string} [por] - quem pediu (painel: e-mail e IP)
   * @returns {{ mudou: boolean }}
   * @throws {Error} pedido inválido (mensagem para o usuário)
   */
  definir({ status, modo }, por = null, agora = new Date()) {
    if (!MODOS.includes(modo)) throw new Error('modo deve ser "manual" ou "automatico"');
    if (modo === 'manual' && !STATUS.includes(status)) throw new Error(`status deve ser ${STATUS.join(', ')}`);
    const nova = modo === 'manual' ? { modo, status, desde: agora.toISOString(), por } : { modo, status: null, desde: agora.toISOString(), por };
    const mudou = nova.modo !== this.escolha.modo || nova.status !== this.escolha.status;
    if (!mudou) return { mudou };
    this.escolha = nova;
    this.repositorio?.salvar(this.escolha);
    this.log.aviso(modo === 'manual'
      ? `Status da URA fixado em ${status.toUpperCase()} pela supervisão${por ? ` (${por})` : ''}: o termômetro automático fica de lado até voltar ao automático.`
      : `Status da URA de volta ao automático (termômetro)${por ? ` (${por})` : ''}.`);
    return { mudou };
  }

  /** Status que vale agora: o manual ou o do termômetro. */
  atual(termometro) {
    return this.manual ? this.escolha.status : termometro?.estado ?? 'medindo';
  }

  /** Para o painel: o que vale, o modo e desde quando está nesse status. */
  resumo(termometro) {
    const automatico = termometro?.resumo() ?? null;
    return {
      status: this.atual(termometro),
      modo: this.escolha.modo,
      desde: this.manual ? this.escolha.desde : automatico?.desde ?? null,
      por: this.manual ? this.escolha.por : null,
      automatico,
    };
  }
}

module.exports = { StatusUra, STATUS };
