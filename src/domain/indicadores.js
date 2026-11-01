'use strict';
/**
 * [NOVO] Indicadores da última hora, para os alertas do painel (src/painel/vigia-indicadores.js):
 *  - OPL dos últimos 15 min: o tempo livre de todos somado ÷ as derivações. Sem derivação, todo o
 *    tempo livre (pelo menos isso por lead);
 *  - TOR da última hora: minutos com alguém livre na URA e todos os robôs desligados.
 * Recebe uma amostra por ciclo da URA (livres e robôs ligados) e cada derivação. Guarda só 1 h.
 */

const MIN = 60_000;
const JANELA_OPL_MS = 15 * MIN;
const JANELA_TOR_MS = 60 * MIN;
/** Buraco entre amostras (rodízio parado): conta no máximo isto. */
const MAX_INTERVALO_MS = 30_000;

class JanelaDeIndicadores {
  constructor() {
    /** { ts, livres, robosLigados } em ordem */
    this.amostras = [];
    this.derivacoes = [];
  }

  amostrar(agora, { livres, robosLigados }) {
    this.amostras.push({ ts: agora, livres: livres || 0, robosLigados: robosLigados ?? null });
    this.descartar(agora);
  }

  registrarDerivacao(agora) {
    this.derivacoes.push(agora);
    this.descartar(agora);
  }

  descartar(agora) {
    const desde = agora - JANELA_TOR_MS;
    while (this.amostras.length && this.amostras[0].ts < desde) this.amostras.shift();
    while (this.derivacoes.length && this.derivacoes[0] < desde) this.derivacoes.shift();
  }

  /** Soma `valor(amostra)` × tempo, entre as amostras de `desde` até agora. */
  integrar(desde, valor) {
    let ms = 0;
    for (let i = 1; i < this.amostras.length; i++) {
      const antes = this.amostras[i - 1];
      if (antes.ts < desde) continue;
      ms += Math.min(Math.max(this.amostras[i].ts - antes.ts, 0), MAX_INTERVALO_MS) * valor(antes);
    }
    return ms;
  }

  /** @returns {{ opl15Seg: number|null, derivacoes15: number, tor60Min: number, coberturaMin: number }} */
  resumo(agora = Date.now()) {
    const desdeOpl = agora - JANELA_OPL_MS;
    const livresSeg = this.integrar(desdeOpl, (a) => a.livres) / 1000;
    const derivacoes15 = this.derivacoes.filter((t) => t >= desdeOpl && t <= agora).length;
    const opl15Seg = derivacoes15 ? Math.round(livresSeg / derivacoes15) : livresSeg > 0 ? Math.round(livresSeg) : null;
    const torMs = this.integrar(agora - JANELA_TOR_MS, (a) => (a.livres > 0 && a.robosLigados === 0 ? 1 : 0));
    const primeira = this.amostras[0]?.ts ?? agora;
    return {
      opl15Seg,
      derivacoes15,
      tor60Min: Math.round((torMs / MIN) * 10) / 10,
      coberturaMin: Math.round(((agora - Math.max(primeira, desdeOpl)) / MIN) * 10) / 10,
    };
  }
}

module.exports = { JanelaDeIndicadores, JANELA_OPL_MS, JANELA_TOR_MS };
