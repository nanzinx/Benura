'use strict';
/**
 * Termômetro da URA: agressiva, normal ou calma, pelo tempo que os humanos livres
 * esperam por uma ligação (média dos últimos minutos). As faixas ficam em
 * src/config/uraThresholds.js.
 *
 * Entram na média as esperas que terminaram em atendimento dentro da janela e as
 * que ainda estão correndo (quem está livre agora). Sem nenhuma das duas (ninguém
 * livre e nenhuma derivação na janela), o estado fica como estava.
 *
 * Calma, o pânico age como na URA passiva (com 1 fixo livre, os robôs seguem).
 * Callback recente = agressiva, seja qual for a espera.
 */

const LIMIARES = require('../config/uraThresholds');

const Estado = Object.freeze({ MEDINDO: 'medindo', CALMA: 'calma', NORMAL: 'normal', AGRESSIVA: 'agressiva' });

/** Estado da faixa em que `segundos` cai (faixas em ordem crescente de `de`). */
function estadoDaEspera(segundos, faixas = LIMIARES.faixas) {
  let estado = faixas[0].estado;
  for (const f of faixas) if (segundos >= f.de) estado = f.estado;
  return estado;
}

class TermometroUra {
  /**
   * @param {object} deps
   * @param {object} deps.logger
   * @param {typeof LIMIARES} [deps.limiares]
   */
  constructor({ logger, limiares = LIMIARES }) {
    Object.assign(this, { log: logger, limiares });
    /** { ts, esperaMs } de cada atendimento: quanto o humano esperou livre até a ligação chegar */
    this.esperas = [];
    /** esperas de quem está livre agora (ms), da última amostra */
    this.emCurso = [];
    this.callbacks = [];
    this.estado = Estado.MEDINDO;
    this.desde = null;
  }

  /** Um ciclo da URA: há quanto tempo cada humano livre está esperando. @returns {string} o estado */
  amostrar(agora, { esperasEmCursoMs = [] } = {}) {
    this.emCurso = esperasEmCursoMs.filter((ms) => ms >= 0);
    return this.reavaliar(agora);
  }

  /** Um humano livre começou a atender, depois de esperar `esperaMs`. */
  registrarDerivacao(agora, esperaMs) {
    if (Number.isFinite(esperaMs) && esperaMs >= 0) this.esperas.push({ ts: agora, esperaMs });
  }

  /** Cliente desistiu da fila: a URA está agressiva agora. */
  registrarCallback(ts, agora = Date.now()) {
    this.callbacks.push(Math.min(ts ?? agora, agora));
    this.reavaliar(agora);
  }

  podar(agora) {
    const limite = agora - this.limiares.janelaMs;
    while (this.esperas.length && this.esperas[0].ts < limite) this.esperas.shift();
    const limiteCallback = agora - (this.limiares.callbackDeixaAgressivaMs || 0);
    while (this.callbacks.length && this.callbacks[0] < limiteCallback) this.callbacks.shift();
  }

  /** @returns {{ esperaSeg: number|null, atendimentos: number, livresAgora: number }} */
  medida(agora) {
    this.podar(agora);
    const todas = [...this.esperas.map((e) => e.esperaMs), ...this.emCurso];
    const esperaSeg = todas.length ? Math.round(todas.reduce((s, ms) => s + ms, 0) / todas.length / 1000) : null;
    return { esperaSeg, atendimentos: this.esperas.length, livresAgora: this.emCurso.length };
  }

  classificar(agora) {
    const { esperaSeg } = this.medida(agora);
    if (this.limiares.callbackDeixaAgressivaMs && this.callbacks.length) return Estado.AGRESSIVA;
    if (esperaSeg == null) return this.estado; // sem dado: fica como estava
    return estadoDaEspera(esperaSeg, this.limiares.faixas);
  }

  reavaliar(agora) {
    const novo = this.classificar(agora);
    if (novo === this.estado) return novo;
    const anterior = this.estado;
    this.estado = novo;
    this.desde = agora;
    this.log.info(`Termômetro da URA: ${anterior} → ${novo} (${this.descrever(agora)}).`);
    return novo;
  }

  calma() {
    return this.estado === Estado.CALMA;
  }

  descrever(agora) {
    const { esperaSeg, atendimentos, livresAgora } = this.medida(agora);
    const janela = Math.round(this.limiares.janelaMs / 60_000);
    if (this.callbacks.length) return 'callback há pouco';
    return `livres esperando ${esperaSeg ?? '?'} s em média nos últimos ${janela} min: ${atendimentos} atendimento(s), ${livresAgora} livre(s) agora`;
  }

  resumo(agora = Date.now()) {
    const { esperaSeg, atendimentos, livresAgora } = this.medida(agora);
    return {
      estado: this.estado,
      desde: this.desde ? new Date(this.desde).toISOString() : null,
      esperaSeg,
      atendimentos,
      livresAgora,
      callbacks: this.callbacks.length,
      janelaMin: Math.round(this.limiares.janelaMs / 60_000),
      faixas: this.limiares.faixas.map((f) => ({ estado: f.estado, deSeg: f.de })),
    };
  }
}

module.exports = { TermometroUra, Estado, estadoDaEspera };
