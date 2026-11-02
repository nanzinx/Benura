'use strict';
/**
 * [NOVO] Saúde da Argus vista por este serviço, nos últimos 15 min (painel, aba Serviços): quantas
 * chamadas, quantas deram erro, quantas foram lentas, quantos pedidos de desacelerar (HTTP 429) e
 * quantas ficaram seguradas pela pausa. Serve para saber na hora se o problema é a Argus ou o BenURA.
 * Guarda um contador por minuto (no máximo 15): memória fixa, sem guardar o conteúdo das chamadas.
 */

const JANELA_MIN = 15;
const MIN_MS = 60_000;
/** Chamada que demorou isso ou mais conta como lenta. */
const LENTA_MS = 3000;

const vazio = (minuto) => ({ minuto, chamadas: 0, erros: 0, limites: 0, seguradas: 0, lentas: 0, msSoma: 0 });

class SaudeDaArgus {
  constructor() {
    this.minutos = [];
    this.ultimoErro = null;
    this.ultimoLimiteEm = null;
    this.pausaAte = 0;
  }

  /**
   * @param {{ ms: number, resultado: 'ok'|'erro'|'limite'|'segurada', texto?: string }} chamada
   *        segurada = não saiu porque a Argus pediu para desacelerar (pausa)
   */
  registrar({ ms, resultado, texto }, agora = Date.now()) {
    const b = this.doMinuto(agora);
    if (resultado === 'segurada') {
      b.seguradas += 1;
      return;
    }
    b.chamadas += 1;
    b.msSoma += ms;
    if (ms >= LENTA_MS) b.lentas += 1;
    if (resultado === 'erro') {
      b.erros += 1;
      this.ultimoErro = { em: new Date(agora).toISOString(), texto: String(texto ?? 'erro').slice(0, 200) };
    }
    if (resultado === 'limite') {
      b.limites += 1;
      this.ultimoLimiteEm = new Date(agora).toISOString();
    }
  }

  doMinuto(agora) {
    const minuto = Math.floor(agora / MIN_MS);
    let b = this.minutos.at(-1);
    if (!b || b.minuto !== minuto) {
      b = vazio(minuto);
      this.minutos.push(b);
      this.descartar(agora);
    }
    return b;
  }

  descartar(agora) {
    const desde = Math.floor(agora / MIN_MS) - JANELA_MIN + 1;
    while (this.minutos.length && this.minutos[0].minuto < desde) this.minutos.shift();
  }

  resumo(agora = Date.now()) {
    this.descartar(agora);
    const soma = (campo) => this.minutos.reduce((t, b) => t + b[campo], 0);
    const chamadas = soma('chamadas');
    return {
      janelaMin: JANELA_MIN,
      chamadas,
      erros: soma('erros'),
      limites: soma('limites'),
      seguradas: soma('seguradas'),
      lentas: soma('lentas'),
      msMedio: chamadas ? Math.round(soma('msSoma') / chamadas) : null,
      ultimoErro: this.ultimoErro,
      ultimoLimiteEm: this.ultimoLimiteEm,
      pausaAte: this.pausaAte > agora ? new Date(this.pausaAte).toISOString() : null,
    };
  }
}

module.exports = { SaudeDaArgus, LENTA_MS };
