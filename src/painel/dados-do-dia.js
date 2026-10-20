'use strict';
/**
 * O dia da URA, lido dos logs em arquivo (logs/AAAA-MM-DD/), para o painel.
 *
 * Lê cada arquivo aos poucos: guarda até onde leu e, a cada consulta, só as
 * linhas novas (o rodizio.txt passa de alguns MB no fim do dia). Na virada do
 * dia começa do zero com a pasta nova. Os logs já não têm dado de cliente.
 */

const fs = require('fs');
const path = require('path');
const { dataLocal } = require('../utils/datas');
const { lerMudancaDeLivres, lerCallback, lerAviso } = require('../domain/painel');

const MAX_PONTOS = 5000;
const MAX_AVISOS = 200;
const BLOCO_BYTES = 1024 * 1024;

/** Linhas novas de um arquivo desde a última leitura. */
class LeitorIncremental {
  constructor(arquivo) {
    this.arquivo = arquivo;
    this.posicao = 0;
    this.resto = '';
  }

  /** @returns {string[]} */
  novasLinhas() {
    let tamanho;
    try {
      tamanho = fs.statSync(this.arquivo).size;
    } catch {
      return []; // ainda não existe (ninguém escreveu hoje)
    }
    if (tamanho < this.posicao) Object.assign(this, { posicao: 0, resto: '' }); // recriado
    const linhas = [];
    const fd = fs.openSync(this.arquivo, 'r');
    try {
      while (this.posicao < tamanho) {
        const buffer = Buffer.alloc(Math.min(BLOCO_BYTES, tamanho - this.posicao));
        const lidos = fs.readSync(fd, buffer, 0, buffer.length, this.posicao);
        if (!lidos) break;
        this.posicao += lidos;
        const partes = (this.resto + buffer.toString('utf8', 0, lidos)).split(/\r?\n/);
        this.resto = partes.pop();
        linhas.push(...partes);
      }
    } finally {
      fs.closeSync(fd);
    }
    return linhas;
  }
}

class DadosDoDia {
  /**
   * @param {object} deps
   * @param {string} deps.pasta - LOGS_DIR
   * @param {string} deps.fuso
   * @param {() => Date} [deps.agora]
   */
  constructor({ pasta, fuso, agora = () => new Date() }) {
    Object.assign(this, { pasta, fuso, agora });
    this.dia = null;
  }

  /** Começa um dia novo (ou o primeiro). */
  abrirDia(dia) {
    const arquivo = (nome) => new LeitorIncremental(path.join(this.pasta, dia, nome));
    Object.assign(this, {
      dia,
      leitores: { rodizio: arquivo('rodizio.txt'), callbacks: arquivo('callbacks.txt'), avisos: arquivo('avisos.txt') },
      linhaDoTempo: [],
      callbacks: [],
      avisos: [],
    });
  }

  /** Lê o que entrou nos logs desde a última vez. */
  atualizar() {
    const hoje = dataLocal(this.fuso, this.agora());
    if (hoje !== this.dia) this.abrirDia(hoje);
    for (const linha of this.leitores.rodizio.novasLinhas()) {
      const ponto = lerMudancaDeLivres(linha);
      if (ponto) this.linhaDoTempo.push(ponto);
    }
    for (const linha of this.leitores.callbacks.novasLinhas()) {
      const cb = lerCallback(linha);
      if (cb) this.callbacks.push(cb);
    }
    for (const linha of this.leitores.avisos.novasLinhas()) {
      const aviso = lerAviso(linha);
      if (aviso) this.avisos.push(aviso);
    }
    if (this.linhaDoTempo.length > MAX_PONTOS) this.linhaDoTempo.splice(0, this.linhaDoTempo.length - MAX_PONTOS);
    if (this.avisos.length > MAX_AVISOS) this.avisos.splice(0, this.avisos.length - MAX_AVISOS);
    return this;
  }

  /** Para GET /api/dia: o dia inteiro (gráficos e lista de callbacks). */
  resumo() {
    this.atualizar();
    return { dia: this.dia, linhaDoTempo: this.linhaDoTempo, callbacks: this.callbacks, avisos: this.avisos.slice(-50).reverse() };
  }
}

module.exports = { DadosDoDia, LeitorIncremental };
