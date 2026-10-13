'use strict';
/**
 * Quem o roteador de vendas fixou na URA hoje (carga do dia ou venda de hoje).
 *
 * O roteador e o rodízio mexem nos mesmos ramais sem se falar. Se o rodízio
 * "empresta" um vendedor à URA e, nesse meio-tempo, o roteador decide que ele
 * fica na URA o resto do dia, o rodízio não pode devolvê-lo ao Ativo depois de
 * TEMPO_MIN. A fonte é o arquivo de estado do roteador (STATE_FILE), no mesmo
 * PC: só leitura, relido apenas quando o arquivo muda. Sem o arquivo (roteador
 * desligado), ninguém é fixo e o rodízio segue como antes.
 */

const fs = require('fs');
const { lerComBackup } = require('../utils/persistencia-json');

const FILA_URA = 'URA';

/** Ramais com fila URA no estado do roteador, se o estado for de `hoje`. */
function ramaisFixosNaUra(estado, hoje) {
  if (!estado || estado.data !== hoje || typeof estado.vendedores !== 'object') return new Set();
  return new Set(Object.entries(estado.vendedores)
    .filter(([, v]) => v?.fila === FILA_URA)
    .map(([ramal]) => String(ramal)));
}

class FixosDoRoteador {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo - STATE_FILE do roteador
   * @param {{ hoje(): string }} deps.relogio
   */
  constructor({ arquivo, relogio }) {
    this.arquivo = arquivo;
    this.relogio = relogio;
    this.versao = null;
    this.estado = null;
  }

  /** @returns {Set<string>} */
  ramais() {
    this.recarregarSeMudou();
    return ramaisFixosNaUra(this.estado, this.relogio.hoje());
  }

  recarregarSeMudou() {
    let versao;
    try {
      versao = fs.statSync(this.arquivo).mtimeMs;
    } catch {
      this.estado = null; // roteador nunca rodou ou o arquivo foi apagado
      return;
    }
    if (versao === this.versao) return;
    this.versao = versao;
    this.estado = lerComBackup(this.arquivo).dados;
  }
}

module.exports = { FixosDoRoteador, ramaisFixosNaUra };
