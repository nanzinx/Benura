'use strict';
/**
 * Quem pode subir do Ativo para a URA pelo rodízio: a lista do dia do roteador
 * (state-vendas.json, fila "URA" = meta de ontem, venda hoje ou fixo).
 *
 * O roteador e o rodízio são processos separados; o arquivo é relido só quando
 * muda. Sem a lista do dia (roteador desligado, carga adiada porque o Carrossel
 * falhou, arquivo de ontem), o rodízio gira todos, como antes, e avisa.
 */

const { ArquivoJsonObservado } = require('../utils/arquivo-json');
const { dataLocal } = require('../utils/datas');
const { elegiveisDoEstado } = require('../domain/rodizio');

const mesmaLista = (a, b) => a === b || (a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((r) => b.has(r)));

class ElegiveisUra {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo - STATE_FILE do roteador
   * @param {string} deps.fusoHorario
   * @param {object} deps.logger
   */
  constructor({ arquivo, fusoHorario, logger }) {
    Object.assign(this, { arquivo, fusoHorario, log: logger });
    this.fonte = new ArquivoJsonObservado(arquivo);
    this.estado = null; // último conteúdo bom do arquivo
    this.ramais = undefined; // Set = lista do dia; null = sem lista (gira todos); undefined = ainda não lido
  }

  /** Relê o arquivo se mudou e confere se a lista é de hoje. */
  atualizar(agora = new Date()) {
    const lido = this.fonte.verificar();
    if (lido.estado === 'atualizado') this.estado = lido.dados;
    if (lido.estado === 'ausente') this.estado = null;
    // 'invalido': o roteador grava de forma atômica; mantém a última versão boa.

    const ramais = elegiveisDoEstado(this.estado, dataLocal(this.fusoHorario, agora));
    if (mesmaLista(this.ramais, ramais)) return;
    this.registrarMudanca(this.ramais, ramais);
    this.ramais = ramais;
  }

  registrarMudanca(antes, depois) {
    if (!depois) {
      this.log.aviso(`Sem a lista de elegíveis do dia (${this.arquivo} ausente ou de outro dia; o roteador está rodando?). `
        + 'Todos que atenderem no Ativo vão para a URA, como antes.');
      return;
    }
    const novos = antes instanceof Set ? [...depois].filter((r) => !antes.has(r)) : [];
    this.log.info(`Elegíveis para a URA: ${depois.size} (meta de ontem, venda hoje ou fixo)`
      + `${novos.length ? `; novos: ${novos.join(', ')}` : ''}. Os demais ficam no Ativo.`);
  }

  /** @returns {boolean} sem a lista do dia, todos podem */
  permite(ramal) {
    return !this.ramais || this.ramais.has(String(ramal));
  }

  resumo() {
    return { disponivel: this.ramais instanceof Set, total: this.ramais?.size ?? null };
  }
}

module.exports = { ElegiveisUra };
